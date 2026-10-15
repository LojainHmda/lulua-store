import { collection, deleteDoc, doc, runTransaction, serverTimestamp } from "firebase/firestore";
import { notifyLowStock } from "../admin/lowStockNotify";
import { normalizeProduct, stockCellKey, toStockByCell } from "../admin/productVariants";
import { computeStockDeltas } from "../admin/stockMovements";
import type { AdminColorVariant, AdminDiscount, AdminProduct, BranchStockDoc, DeliveryZone, OrderLine, OrderStatus, PaymentMethod, RegisterSession, ShippingSettingsDoc } from "../admin/types";
import { resolveDeliveryFee, SHIPPING_DEFAULTS } from "../data/deliveryZones";
import { auth } from "./auth";
import { branchStockId, withBranchStock } from "./branchStock";
import { db } from "./config";

export const MAX_CHECKOUT_LINES = 8;

export interface PlaceOrderLineInput {
  productId: string;
  variantId: string;
  size: string;
  qty: number;
  // Optional, customer-authored, scoped to this exact line (see
  // CartLine.note). Trimmed and omitted entirely here if blank so callers
  // don't need to duplicate that logic.
  note?: string;
}

export interface PlaceOrderInput {
  lines: PlaceOrderLineInput[];
  customerName: string;
  customerEmail: string;
  customerPhone?: string;
  shippingAddress?: string;
  // Required for a genuine web checkout (see the isPos check below) --
  // the id of the deliveryZones/{id} doc the customer selected. Never set
  // for POS, which charges no delivery fee at all.
  deliveryZoneId?: string;
  notes?: string;
  // POS-only (Phase 4): a cashier ringing up an in-store sale reuses this
  // exact transaction with source "pos" — no shipping, sale completes
  // immediately, and the sale is tied to the cashier's open register.
  source?: "web" | "pos";
  status?: OrderStatus;
  customerId?: string;
  // POS only: a cashier's manual, code-free discount amount (see
  // src/pos/Terminal.tsx) — trusted because it requires cashier-or-above
  // privilege, unrelated to the discount-code system entirely. Never used
  // for a web checkout; see discountId below for that path.
  discount?: number;
  // Web checkout only: the discounts/{id} a customer applied at Checkout
  // (src/pages/Checkout.tsx). The actual discount amount is re-derived
  // authoritatively from this doc inside the transaction below, never
  // trusted from client input — closes the audit's A1 finding (a client
  // could otherwise submit discount=subtotal with no real code at all).
  // firestore.rules' isValidDiscountForOrder independently re-checks the
  // same thing, since this function isn't the only way to write an order.
  discountId?: string;
  paymentMethod?: PaymentMethod;
  cashAmount?: number;
  cardAmount?: number;
  registerSessionId?: string;
  // Required for web orders (see the isPos check below) — the exchange
  // policy version/language the customer actually saw and accepted just
  // before clicking place order. Never required for POS: an in-store sale
  // has no checkout form or consent step to begin with.
  policyConsent?: { policyVersion: number; lang: "en" | "ar" };
}

export interface PlaceOrderResult {
  orderId: string;
  orderNumber: string;
  total: number;
}

export class PlaceOrderError extends Error {}

interface ClaimLine {
  productId: string;
  variantId: string;
  size: string;
  qty: number;
  price: number;
}

export async function placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
  const user = auth.currentUser;
  if (!user) throw new PlaceOrderError("You need to be signed in to check out.");
  if (input.lines.length === 0) throw new PlaceOrderError("Your bag is empty.");
  if (input.lines.length > MAX_CHECKOUT_LINES) {
    throw new PlaceOrderError(`Orders are limited to ${MAX_CHECKOUT_LINES} different items — please split into two orders.`);
  }

  const isPos = input.source === "pos";
  // Belt-and-suspenders alongside Checkout.tsx's own gate and the Firestore
  // rules' structural requirement (see isValidCheckoutOrder in
  // firestore.rules): this function is the one place both the UI and any
  // other future caller are forced through, so it's where "no consent, no
  // order" is actually guaranteed for the web flow.
  if (!isPos && !input.policyConsent) {
    throw new PlaceOrderError("Please review and accept the exchange policy before placing your order.");
  }
  // Same belt-and-suspenders reasoning as policyConsent above -- Checkout.tsx
  // already requires a zone to be selected before it will submit, and
  // firestore.rules' isValidCheckoutOrder() independently requires the field
  // to be a non-empty string, but this is the one place both the UI and any
  // other future web caller are forced through.
  if (!isPos && !input.deliveryZoneId) {
    throw new PlaceOrderError("Please select a delivery city/region before placing your order.");
  }
  const uid = user.uid;
  const claimRef = doc(db, "checkoutClaims", uid);
  const orderRef = doc(collection(db, "orders"));
  const deliveryZoneRef = !isPos && input.deliveryZoneId ? doc(db, "deliveryZones", input.deliveryZoneId) : null;
  const customerId = input.customerId ?? (isPos ? undefined : uid);
  const customerRef = customerId ? doc(db, "customers", customerId) : null;
  const shippingSettingsRef = doc(db, "settings", "shipping");
  const sessionRef = input.registerSessionId ? doc(db, "registerSessions", input.registerSessionId) : null;
  const discountRef = input.discountId ? doc(db, "discounts", input.discountId) : null;

  const distinctProductIds = [...new Set(input.lines.map((l) => l.productId))];
  const productRefs = distinctProductIds.map((id) => doc(db, "products", id));

  // Populated inside the transaction below (which already reads the "before"
  // state and computes the "after" state for every product it touches, at no
  // extra cost), then used AFTER the transaction commits to raise low-stock
  // alerts — see notifyLowStock's own comment for why that has to happen
  // outside the transaction rather than as part of it. Reassigned to a
  // fresh array at the top of every transaction attempt (see the reset
  // right inside the callback below), never accumulated across a retry —
  // otherwise a failed attempt's entries would survive alongside the
  // successful attempt's, and the loop after runTransaction() would raise
  // notifyLowStock() twice per product: once with a stale before/after pair
  // that was never actually committed, once with the real one.
  let stockChanges: { product: { id: string; name: string }; before: AdminProduct["colorVariants"]; after: AdminColorVariant[] }[] = [];

  const result = await runTransaction(db, async (tx) => {
    // Reset on every attempt, including retries — Firestore replays this
    // whole callback from scratch on a write-conflict retry, and this array
    // is read from OUTSIDE the callback after commit, so it must never hold
    // a mix of a discarded attempt's entries and the real one's.
    stockChanges = [];
    const sessionSnap = sessionRef ? await tx.get(sessionRef) : null;
    // Multi-branch POS: a sale on a branch register sells from THAT branch's
    // stock (branchStock/{branchId}__{productId}), never from the online
    // stock on the product document. The branch comes from the register
    // session read inside this transaction -- never from client input.
    const session = isPos && sessionSnap?.exists() ? (sessionSnap.data() as Omit<RegisterSession, "id">) : null;
    if (isPos && session && session.status !== "open") {
      throw new PlaceOrderError("This register session is closed. Open the register again to continue selling.");
    }
    const branchId = isPos ? session?.branchId : undefined;
    const branchRefs = branchId ? distinctProductIds.map((id) => doc(db, "branchStock", branchStockId(branchId, id))) : [];
    const productSnaps = await Promise.all(productRefs.map((ref) => tx.get(ref)));
    const branchSnaps = await Promise.all(branchRefs.map((ref) => tx.get(ref)));
    const branchStockByProduct = new Map<string, BranchStockDoc>();
    branchSnaps.forEach((snap, i) => {
      if (snap.exists()) branchStockByProduct.set(distinctProductIds[i], { id: snap.id, ...snap.data() } as BranchStockDoc);
    });
    const shippingSnap = isPos ? null : await tx.get(shippingSettingsRef);
    const deliveryZoneSnap = deliveryZoneRef ? await tx.get(deliveryZoneRef) : null;
    const customerSnap = customerRef && !user.isAnonymous ? await tx.get(customerRef) : null;
    const discountSnap = discountRef ? await tx.get(discountRef) : null;

    const productById = new Map<string, AdminProduct>();
    productSnaps.forEach((snap, i) => {
      if (!snap.exists()) throw new PlaceOrderError("One of the items in your bag is no longer available.");
      const normalized = normalizeProduct({ id: snap.id, ...snap.data() } as AdminProduct);
      // Branch sale: validate against the branch's own counts (absent cell =
      // 0 at this branch). Prices/names/colors still come from the product.
      productById.set(distinctProductIds[i], branchId ? withBranchStock(normalized, branchStockByProduct.get(distinctProductIds[i])) : normalized);
    });

    const claimLines: ClaimLine[] = [];
    const orderLines: OrderLine[] = [];
    let subtotal = 0;

    for (const line of input.lines) {
      const product = productById.get(line.productId);
      if (!product || product.status !== "active") {
        throw new PlaceOrderError(`${product?.name ?? "An item"} in your bag is no longer available.`);
      }
      const variant = product.colorVariants.find((v) => v.id === line.variantId);
      if (!variant) throw new PlaceOrderError(`${product.name} is no longer available in that color.`);
      const stockEntry = variant.sizeStock.find((s) => s.size === line.size);
      if (!stockEntry) {
        throw new PlaceOrderError(`${product.name} (${variant.colorName}, ${line.size}) doesn't have enough stock left.`);
      }
      // qty: null means the real count was never confirmed — never treat
      // that as 0 (would wrongly block a possibly-in-stock item forever)
      // or as unlimited (would let this sell with no real stock backing
      // it). Refuse the sale explicitly instead, for both web checkout and
      // POS (this function is shared by both — see PlaceOrderInput.source).
      if (stockEntry.qty === null) {
        throw new PlaceOrderError(`${product.name} (${variant.colorName}, ${line.size}) needs its stock count confirmed before it can be sold.`);
      }
      if (stockEntry.qty < line.qty) {
        throw new PlaceOrderError(
          branchId
            ? `${product.name} (${variant.colorName}, ${line.size}) doesn't have enough stock at this branch (${stockEntry.qty} left).`
            : `${product.name} (${variant.colorName}, ${line.size}) doesn't have enough stock left.`
        );
      }

      subtotal += product.price * line.qty;
      claimLines.push({ productId: line.productId, variantId: line.variantId, size: line.size, qty: line.qty, price: product.price });
      orderLines.push({
        productId: line.productId,
        variantId: line.variantId,
        name: product.name,
        qty: line.qty,
        price: product.price,
        size: line.size,
        color: variant.colorName,
        imageId: variant.imageId,
        imageUrl: variant.imageUrl,
        // Blank/whitespace-only notes are omitted entirely (relies on this
        // client's ignoreUndefinedProperties) rather than written as "" --
        // keeps "no note" and "empty note" the same, unambiguous state.
        note: line.note?.trim() || undefined,
      });
    }

    let shipping = 0;
    let deliveryZone: DeliveryZone | null = null;
    if (!isPos) {
      const shippingSettings = shippingSnap?.exists() ? { ...SHIPPING_DEFAULTS, ...(shippingSnap.data() as ShippingSettingsDoc) } : SHIPPING_DEFAULTS;
      // The zone doc is the authoritative source for the fee -- never trust
      // whatever fee the client's own live preview computed. A missing or
      // inactive zone, or a corrupt/negative fee, rejects the whole order
      // rather than silently falling back to any other rate (mirrors the
      // discount-code validation immediately below, and firestore.rules'
      // own isValidShippingForOrder independently re-checks the same thing).
      if (deliveryZoneSnap?.exists()) {
        deliveryZone = { id: deliveryZoneSnap.id, ...deliveryZoneSnap.data() } as DeliveryZone;
      }
      const fee = resolveDeliveryFee(deliveryZone ?? undefined, subtotal, shippingSettings.freeShippingThreshold);
      if (fee === null) {
        throw new PlaceOrderError("That delivery city/region is no longer available. Please choose another one.");
      }
      shipping = fee;
    }

    // Re-derived from a live discounts/{id} read, exactly mirroring
    // lookupDiscountCode()'s own validity checks (src/firebase/
    // discountCodes.ts) — never trusts input.discount for this path. POS's
    // manual, code-free discount (Terminal.tsx) is the one legitimate case
    // that still uses input.discount directly, since it requires
    // cashier-or-above privilege and was never part of this vulnerability.
    let discount = 0;
    if (input.discountId) {
      if (!discountSnap?.exists()) throw new PlaceOrderError("That discount code is no longer valid.");
      const d = discountSnap.data() as AdminDiscount;
      const notExpired = !d.expiresAt || new Date(d.expiresAt + "T23:59:59").getTime() >= Date.now();
      const underLimit = d.usageLimit == null || d.usageCount < d.usageLimit;
      const meetsMin = d.minSubtotal == null || subtotal >= d.minSubtotal;
      if (!d.active || !notExpired || !underLimit || !meetsMin) {
        throw new PlaceOrderError("That discount code is no longer valid.");
      }
      const rawAmount = d.type === "percent" ? subtotal * (d.value / 100) : d.value;
      discount = Math.min(rawAmount, subtotal);
    } else if (isPos) {
      discount = Math.min(input.discount ?? 0, subtotal);
    }
    const total = subtotal - discount + shipping;

    tx.set(claimRef, { lines: claimLines });

    // Collected here (a plain local, naturally fresh on every transaction
    // attempt, same as the stockChanges reset above) and written as
    // stockMovements docs below, once orderNumber exists. A retried
    // attempt's tx.set() calls are simply discarded by Firestore's
    // transaction machinery along with everything else that attempt wrote —
    // only the final, successful attempt's movements are ever committed.
    const pendingMovements: { productId: string; productName: string; variantId: string; colorName: string; size: string; qtyBefore: number; qtyChange: number; qtyAfter: number }[] = [];

    if (branchId) {
      // Writes ONLY the claimed cells of the branch doc's stockByCell, each
      // reduced by exactly the claimed qty -- the shape firestore.rules'
      // isValidBranchStockSale() (via stockDecreaseMatchesClaimFlat) accepts.
      // Rebuilding the whole map from the joined product would add cells this
      // branch never had (as 0) and fail that check.
      distinctProductIds.forEach((productId, i) => {
        const product = productById.get(productId)!;
        const before = branchStockByProduct.get(productId)!.stockByCell;
        const after = { ...before };
        for (const l of claimLines.filter((c) => c.productId === productId)) {
          const key = stockCellKey(l.variantId, l.size);
          const qtyBefore = after[key].qty as number;
          after[key] = { ...after[key], qty: qtyBefore - l.qty };
          const variant = product.colorVariants.find((v) => v.id === l.variantId)!;
          pendingMovements.push({ productId, productName: product.name, variantId: l.variantId, colorName: variant.colorName, size: l.size, qtyBefore, qtyChange: -l.qty, qtyAfter: qtyBefore - l.qty });
        }
        tx.update(branchRefs[i], { stockByCell: after, updatedAt: serverTimestamp() });
      });
    }

    for (const ref of branchId ? [] : productRefs) {
      const product = productById.get(ref.id)!;
      const claimedForThisProduct = claimLines.filter((l) => l.productId === ref.id);
      const newColorVariants = product.colorVariants.map((variant) => ({
        ...variant,
        sizeStock: variant.sizeStock.map((s) => {
          const claimedQty = claimedForThisProduct
            .filter((l) => l.variantId === variant.id && l.size === s.size)
            .reduce((sum, l) => sum + l.qty, 0);
          // s.qty is guaranteed non-null here for any line actually claimed
          // — the validation loop above already rejected the whole
          // transaction if a claimed line's stock was unknown. The
          // `s.qty !== null` check is just to satisfy the type checker.
          return claimedQty > 0 && s.qty !== null ? { ...s, qty: s.qty - claimedQty } : s;
        }),
      }));
      // Checkout writes ONLY `stockByCell` — never `colorVariants` — so this
      // exactly matches firestore.rules' flat-branch isValidStockDecrement
      // requirement (colorVariants metadata is frozen during checkout by
      // construction; see the colorvariants-map-migration-plan-2026-09-22
      // spike reports for why). computeStockDeltas/notifyLowStock below
      // still work against the full in-memory array, unchanged.
      tx.update(ref, { stockByCell: toStockByCell(newColorVariants), updatedAt: serverTimestamp() });
      stockChanges.push({ product: { id: product.id, name: product.name }, before: product.colorVariants, after: newColorVariants });
      for (const delta of computeStockDeltas(product.colorVariants, newColorVariants)) {
        pendingMovements.push({ productId: product.id, productName: product.name, ...delta });
      }
    }

    // Cashier attribution, POS only -- sourced from the register session
    // already being read in this same transaction (sessionSnap), never a
    // separate read, and from `user` (auth.currentUser) for the uid/email,
    // the same trusted source the paired stockMovements entries below
    // already use. A web checkout is placed by an arbitrary signed-in-or-
    // anonymous shopper; inventing a staff identity for that case would be
    // dishonest, so these three fields simply stay unset for `source:
    // "web"` -- see PlaceOrderInput's own doc comment.
    const cashierName = session?.cashierName;

    const orderNumber = `SIS-${Date.now().toString(36).toUpperCase()}`;
    tx.set(orderRef, {
      orderNumber,
      customerId,
      customerName: input.customerName,
      customerEmail: input.customerEmail,
      customerPhone: input.customerPhone,
      lines: orderLines,
      subtotal,
      discount,
      discountId: input.discountId,
      shipping,
      total,
      status: input.status ?? "pending",
      source: input.source ?? "web",
      shippingAddress: input.shippingAddress,
      // Denormalized from the zone at the moment it was charged (the same
      // "snapshot, don't live-join" convention OrderLine already uses for
      // product name/color) -- undefined for POS, matching `shipping: 0`
      // there having no zone concept at all.
      deliveryZoneId: deliveryZone?.id,
      deliveryZoneName: deliveryZone?.name,
      deliveryZoneNameAr: deliveryZone?.nameAr,
      notes: input.notes,
      paymentMethod: input.paymentMethod,
      cashAmount: input.cashAmount,
      cardAmount: input.cardAmount,
      registerSessionId: input.registerSessionId,
      // Multi-branch: snapshot of where this sale happened, from the session.
      branchId,
      branchName: branchId ? session?.branchName : undefined,
      branchCode: branchId ? session?.branchCode : undefined,
      registerId: branchId ? session?.registerId : undefined,
      registerName: branchId ? session?.registerName : undefined,
      // undefined (POS, or a web caller that somehow skipped the guard
      // above) is dropped by ignoreUndefinedProperties — never written as a
      // literal null/empty consent record.
      policyConsent: input.policyConsent
        ? { policyVersion: input.policyConsent.policyVersion, lang: input.policyConsent.lang, acceptedAt: serverTimestamp() }
        : undefined,
      // Phase A: the cashier who rang this specific sale, directly on the
      // order itself -- undefined (dropped by ignoreUndefinedProperties)
      // for a web checkout or any non-POS source.
      cashierUid: isPos ? user.uid : undefined,
      cashierEmail: isPos ? (user.email ?? undefined) : undefined,
      cashierName: isPos ? (cashierName ?? user.displayName ?? undefined) : undefined,
      // On a POS device the signed-in identity is the till; the real staff
      // member who started the shift comes from the session.
      operatorId: isPos ? session?.operatorId : undefined,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    for (const m of pendingMovements) {
      tx.set(doc(collection(db, "stockMovements")), {
        productId: m.productId,
        productName: m.productName,
        variantId: m.variantId,
        colorName: m.colorName,
        size: m.size,
        qtyBefore: m.qtyBefore,
        qtyChange: m.qtyChange,
        qtyAfter: m.qtyAfter,
        reason: "sale",
        source: isPos ? "pos" : "web",
        actorUid: isPos ? user.uid : undefined,
        actorEmail: isPos ? (user.email ?? undefined) : undefined,
        actorName: isPos ? (cashierName ?? user.displayName ?? undefined) : undefined,
        orderId: orderRef.id,
        orderNumber,
        branchId,
        // Which till rang it up — same session snapshot the order itself stores.
        registerId: branchId ? session?.registerId : undefined,
        registerName: branchId ? session?.registerName : undefined,
        createdAt: serverTimestamp(),
      });
    }

    if (customerSnap?.exists() && customerRef) {
      const data = customerSnap.data() as { ordersCount?: number; totalSpent?: number };
      tx.update(customerRef, {
        ordersCount: (data.ordersCount ?? 0) + 1,
        totalSpent: (data.totalSpent ?? 0) + subtotal,
        updatedAt: serverTimestamp(),
      });
    }

    if (sessionSnap?.exists() && sessionRef) {
      const s = sessionSnap.data() as { salesCount?: number; cashTotal?: number; cardTotal?: number; discountTotal?: number; grossTotal?: number };
      tx.update(sessionRef, {
        salesCount: (s.salesCount ?? 0) + 1,
        cashTotal: (s.cashTotal ?? 0) + (input.cashAmount ?? 0),
        cardTotal: (s.cardTotal ?? 0) + (input.cardAmount ?? 0),
        discountTotal: (s.discountTotal ?? 0) + discount,
        grossTotal: (s.grossTotal ?? 0) + total,
        updatedAt: serverTimestamp(),
      });
    }

    return { orderId: orderRef.id, orderNumber, total };
  });

  // Best-effort cleanup — the claim is a singleton per user that the next
  // checkout overwrites anyway, so a failure here isn't worth surfacing.
  deleteDoc(claimRef).catch(() => {});

  // Fire-and-forget, after the order has already committed successfully —
  // covers both web checkout and POS, since this function is shared by both
  // (see PlaceOrderInput.source). Never awaited: a slow or failing
  // notification write must never delay or affect the checkout result the
  // customer/cashier already has in hand.
  for (const change of stockChanges) {
    void notifyLowStock(change.product, change.before, change.after);
  }

  return result;
}
