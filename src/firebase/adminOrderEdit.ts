import { collection, doc, runTransaction, serverTimestamp } from "firebase/firestore";
import type { Actor } from "../admin/actor";
import { notifyLowStock } from "../admin/lowStockNotify";
import { normalizeProduct, toStockByCell } from "../admin/productVariants";
import { computeStockDeltas } from "../admin/stockMovements";
import type { AdminColorVariant, AdminOrder, AdminProduct, DeliveryZone, OrderLine, ShippingSettingsDoc } from "../admin/types";
import { resolveDeliveryFee, SHIPPING_DEFAULTS } from "../data/deliveryZones";
import { db } from "./config";

export class AdminOrderEditError extends Error {}

export interface EditableLine {
  productId: string;
  variantId: string;
  size: string;
  qty: number;
  // Pass-through only -- this function never lets an admin author/edit the
  // note itself, just rebuilds the line. Callers should forward the line's
  // existing note (e.g. OrderDetail.tsx's already-loaded draftLines) so an
  // edit to unrelated fields (qty, size) doesn't silently drop it.
  note?: string;
}

function lineKey(productId: string, variantId: string, size: string): string {
  return `${productId}::${variantId}::${size}`;
}

// Admin-only (isAdminOrAbove()/isEditorOrAbove() already grant unconditional
// write access to orders/products), so unlike placeOrder() this needs no
// checkoutClaims cross-check — an admin editing an order is trusted the
// same way any other admin product/order edit already is.
export async function updateOrderLines(orderId: string, newLines: EditableLine[], actor: Actor): Promise<void> {
  if (newLines.length === 0) throw new AdminOrderEditError("An order needs at least one item.");

  const orderRef = doc(db, "orders", orderId);

  // Populated inside the transaction (which already reads the "before" state
  // and computes the "after" state for every touched product, at no extra
  // cost), then used AFTER the transaction commits — see notifyLowStock's
  // own comment for why the notification write has to happen outside the
  // transaction rather than as part of it. Reassigned to a fresh array at
  // the top of every transaction attempt (see the reset right inside the
  // callback below), never accumulated across a retry — see
  // orderTransaction.ts's identical pattern for why that matters.
  let stockChanges: { product: { id: string; name: string }; before: AdminProduct["colorVariants"]; after: AdminColorVariant[] }[] = [];

  await runTransaction(db, async (tx) => {
    // Reset on every attempt, including retries — same reasoning as
    // orderTransaction.ts's identical line.
    stockChanges = [];
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists()) throw new AdminOrderEditError("Order not found.");
    const order = orderSnap.data() as AdminOrder;
    if (order.status !== "pending" && order.status !== "processing") {
      throw new AdminOrderEditError("Only pending or processing orders can be edited.");
    }

    // Same guard as cancelOrderAndRestoreStock(): this adjusts ONLINE stock,
    // but a branch POS sale's units came out of that branch's stock.
    if (order.branchId) {
      throw new AdminOrderEditError("This is a branch (POS) sale — its items can't be edited here, because that would change online stock instead of the branch's. Use Returns instead.");
    }

    const oldLines = order.lines;
    const distinctProductIds = [...new Set([...oldLines.map((l) => l.productId), ...newLines.map((l) => l.productId)])];
    const productRefs = distinctProductIds.map((id) => doc(db, "products", id));
    const productSnaps = await Promise.all(productRefs.map((ref) => tx.get(ref)));

    const productById = new Map<string, AdminProduct>();
    productSnaps.forEach((snap, i) => {
      if (!snap.exists()) throw new AdminOrderEditError("One of the products in this order no longer exists.");
      productById.set(distinctProductIds[i], normalizeProduct({ id: snap.id, ...snap.data() } as AdminProduct));
    });

    // Last reads of the transaction — Firestore requires every read to
    // happen before the first write, so these have to sit here and not next
    // to the recalculation they feed at the bottom. Only fetched for a
    // genuine web checkout order (source: "web") — see isWebOrder below for
    // why. The zone is only re-read when the order actually has one stored;
    // a historical order predating this feature (no deliveryZoneId) has
    // nothing to look up and keeps its existing shipping figure untouched.
    const isWebOrder = order.source === "web";
    const shippingSnap = isWebOrder ? await tx.get(doc(db, "settings", "shipping")) : null;
    const deliveryZoneSnap = isWebOrder && order.deliveryZoneId ? await tx.get(doc(db, "deliveryZones", order.deliveryZoneId)) : null;

    // Net stock delta per (product, variant, size): positive = give stock
    // back (line removed/decreased), negative = take stock (added/increased).
    const delta = new Map<string, number>();
    for (const l of oldLines) {
      const k = lineKey(l.productId, l.variantId, l.size);
      delta.set(k, (delta.get(k) ?? 0) + l.qty);
    }
    for (const l of newLines) {
      const k = lineKey(l.productId, l.variantId, l.size);
      delta.set(k, (delta.get(k) ?? 0) - l.qty);
    }

    // Existing lines keep their originally-recorded price even if the qty
    // changed; only a genuinely new (product, variant, size) combination
    // takes the current live price.
    const oldPriceByKey = new Map<string, number>();
    oldLines.forEach((l) => oldPriceByKey.set(lineKey(l.productId, l.variantId, l.size), l.price));

    const updatedOrderLines: OrderLine[] = newLines.map((nl) => {
      const product = productById.get(nl.productId)!;
      const variant = product.colorVariants.find((v) => v.id === nl.variantId);
      if (!variant) throw new AdminOrderEditError(`${product.name}: that color is no longer available.`);
      const stockEntry = variant.sizeStock.find((s) => s.size === nl.size);
      if (!stockEntry) throw new AdminOrderEditError(`${product.name}: that size is no longer available.`);

      const k = lineKey(nl.productId, nl.variantId, nl.size);
      const price = oldPriceByKey.get(k) ?? product.price;

      return {
        productId: nl.productId,
        variantId: nl.variantId,
        name: product.name,
        qty: nl.qty,
        price,
        size: nl.size,
        color: variant.colorName,
        imageId: variant.imageId,
        imageUrl: variant.imageUrl,
        note: nl.note?.trim() || undefined,
      };
    });

    for (const ref of productRefs) {
      const product = productById.get(ref.id)!;
      let touched = false;
      const newColorVariants = product.colorVariants.map((variant) => ({
        ...variant,
        sizeStock: variant.sizeStock.map((s) => {
          const d = delta.get(lineKey(ref.id, variant.id, s.size));
          if (!d) return s;
          touched = true;
          if (s.qty === null) {
            throw new AdminOrderEditError(`${product.name} (${variant.colorName}, ${s.size}) has a stock count that was never confirmed — update its inventory before editing this order.`);
          }
          const newQty = s.qty + d;
          if (newQty < 0) {
            throw new AdminOrderEditError(`${product.name} (${variant.colorName}, ${s.size}) doesn't have enough stock for this change.`);
          }
          return { ...s, qty: newQty };
        }),
      }));
      if (touched) {
        // This edit only ever changes quantities, never a color's metadata —
        // written as `stockByCell` alone (never `colorVariants`), matching
        // every other stock-only writer. Authorized unconditionally via
        // isEditorOrAbove() either way, so this is a style/consistency
        // choice here, not a security requirement the way it is for
        // checkout — see orderTransaction.ts's identical comment.
        tx.update(ref, { stockByCell: toStockByCell(newColorVariants), updatedAt: serverTimestamp() });
        // Queued regardless of whether this particular edit increased or
        // decreased stock — findLowStockCrossings only ever fires on a real
        // downward crossing, so a restock-only edit here is simply a no-op
        // check, never a false alert.
        stockChanges.push({ product: { id: product.id, name: product.name }, before: product.colorVariants, after: newColorVariants });
        // Signed either direction (a line's qty can go up or down on an
        // edit, unlike a sale) — computeStockDeltas already skips any cell
        // that didn't actually change, so a same-quantity line-item swap
        // (e.g. only the size changed) never produces a zero-delta entry.
        for (const movementDelta of computeStockDeltas(product.colorVariants, newColorVariants)) {
          tx.set(doc(collection(db, "stockMovements")), {
            productId: product.id,
            productName: product.name,
            variantId: movementDelta.variantId,
            colorName: movementDelta.colorName,
            size: movementDelta.size,
            qtyBefore: movementDelta.qtyBefore,
            qtyChange: movementDelta.qtyChange,
            qtyAfter: movementDelta.qtyAfter,
            reason: "order_edit",
            source: "admin",
            actorUid: actor.uid,
            actorEmail: actor.email,
            actorName: actor.displayName || actor.email,
            orderId,
            orderNumber: order.orderNumber,
            createdAt: serverTimestamp(),
          });
        }
      }
    }

    const subtotal = updatedOrderLines.reduce((sum, l) => sum + l.price * l.qty, 0);

    // Shipping is re-derived from the live settings/shipping doc exactly the
    // way placeOrder() does it at checkout, rather than carrying the order's
    // original frozen figure forward — but ONLY for a genuine web-checkout
    // order, where shipping was always tied to the storefront's configured
    // rates/free-shipping threshold in the first place: an edit that pushes
    // the subtotal over (or back under) that threshold has to move the
    // shipping line with it, in both directions. POS orders are exempt —
    // they never charge shipping at all, so their stored 0 stands. A
    // manual/off-site order (source unset — see OrderList.tsx's "New Order"
    // form) is exempt too: it can carry a custom-entered shipping cost (a
    // courier quote, a flat rate quoted over the phone, free for a pickup)
    // that has nothing to do with the website's rates, and editing its line
    // items must never silently overwrite that with a recomputed figure.
    let shipping = order.shipping;
    let deliveryZoneName = order.deliveryZoneName;
    let deliveryZoneNameAr = order.deliveryZoneNameAr;
    // Only recomputed for a web order that actually HAS a stored zone. A
    // historical order placed before delivery zones existed (no
    // deliveryZoneId) deliberately keeps its original shipping figure
    // untouched forever — there is no zone to re-derive it from, and
    // inventing one would misrepresent what the customer was actually
    // charged. See adminOrderEdit's own doc comment above for the same
    // reasoning already applied to POS/manual orders.
    if (isWebOrder && order.deliveryZoneId) {
      if (!deliveryZoneSnap?.exists()) {
        throw new AdminOrderEditError("This order's delivery zone no longer exists — resolve it manually via Delivery Zones before editing this order.");
      }
      const zone = { id: deliveryZoneSnap.id, ...deliveryZoneSnap.data() } as DeliveryZone;
      const shippingSettings = shippingSnap?.exists() ? { ...SHIPPING_DEFAULTS, ...(shippingSnap.data() as ShippingSettingsDoc) } : SHIPPING_DEFAULTS;
      // Existence is checked above; active status is deliberately NOT
      // re-checked here (unlike at checkout) -- the order already committed
      // to this exact zone, and an admin later deactivating it for NEW
      // customers shouldn't retroactively break editing an existing order
      // still assigned to it. The fee itself is still always the zone's
      // real, current, admin-set number, never a stale/invented one.
      const fee = resolveDeliveryFee({ active: true, fee: zone.fee }, subtotal, shippingSettings.freeShippingThreshold);
      if (fee === null) {
        throw new AdminOrderEditError(`${zone.name}: its delivery fee is missing or invalid — fix it in Delivery Zones before editing this order.`);
      }
      shipping = fee;
      deliveryZoneName = zone.name;
      deliveryZoneNameAr = zone.nameAr;
    }

    // Any discount already recorded on the order stays applied (and can never
    // exceed the new subtotal), matching placeOrder()'s total formula — the
    // previous `subtotal + shipping` silently dropped it on every edit.
    const discount = Math.min(order.discount ?? 0, subtotal);

    tx.update(orderRef, {
      lines: updatedOrderLines,
      subtotal,
      shipping,
      deliveryZoneName,
      deliveryZoneNameAr,
      total: subtotal - discount + shipping,
      // Stamped unconditionally, even when this particular edit didn't
      // change any quantity that produced a stockMovements entry above
      // (e.g. a note-only change, or a size swap at an unchanged qty) --
      // "who last edited this order's items" must always be answerable
      // from the order itself, not just from the stock ledger.
      linesUpdatedByUid: actor.uid,
      linesUpdatedByEmail: actor.email,
      linesUpdatedByName: actor.displayName || actor.email,
      linesUpdatedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  });

  // Fire-and-forget, after the edit has already committed successfully —
  // never awaited, so a slow or failing notification write can't affect an
  // edit the admin already sees as saved.
  for (const change of stockChanges) {
    void notifyLowStock(change.product, change.before, change.after);
  }
}
