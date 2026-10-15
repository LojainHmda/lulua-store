export type AdminRole = "owner" | "admin" | "editor" | "viewer" | "cashier";

export interface AdminUser {
  id: string; // Firebase Auth uid
  email: string;
  displayName: string;
  role: AdminRole;
  active: boolean;
  // Multi-branch POS: the branches a cashier may sell from. Owner/admin are
  // never restricted by this (they can open any branch's register), so it is
  // only meaningful for role "cashier" -- a cashier with no branch assigned
  // can sign in but can't open any register. Enforced in firestore.rules
  // (registerSessions/orders/branchStock), not just the POS UI.
  branchIds?: string[];
  // Optional narrowing within those branches: when non-empty, the cashier may
  // only open these specific registers. Empty/absent = any register in their
  // assigned branches. UI-level only (a register is a till, not a security
  // boundary -- branch is).
  registerIds?: string[];
  // Set only on POS DEVICE identities: the posLinks token this anonymous
  // device registered itself with (src/firebase/posLinks.ts). Such a doc is
  // a cashier pinned to one branch + register, with no email/password.
  posLink?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

// A physical store location. Every POS register, register session, POS sale
// and branch stock document belongs to exactly one branch.
export interface Branch {
  id: string;
  name: string;
  nameAr?: string;
  // Short code printed on receipts/order lists, e.g. "HQ" or "MALL".
  code: string;
  address?: string;
  phone?: string;
  active: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}

// A POS terminal/till inside a branch. `openSessionId` is the register's
// lock: set atomically together with the session that opens it (see
// registerSession.ts / firestore.rules), cleared when that session closes,
// so two cashiers can never run the same register at the same time.
export interface Register {
  id: string;
  branchId: string;
  name: string;
  // Auto-assigned on create (1, 2, 3...), unique across all branches, never
  // changed afterwards (firestore.rules) -- safe to use in reports/calculations.
  number?: number;
  active: boolean;
  openSessionId?: string | null;
  createdAt?: unknown;
  updatedAt?: unknown;
}

// One branch's stock for one product, doc id `${branchId}__${productId}`
// (see branchStockId()). Same flat "<variantId>::<size>" cell map the
// product document itself uses for online stock, so the existing claim-based
// decrement validation in firestore.rules applies unchanged. A cell that is
// absent here means 0 at this branch (never stocked), not "unknown".
export interface BranchStockDoc {
  id: string;
  branchId: string;
  productId: string;
  stockByCell: Record<string, { qty: number | null; qtyUnknown?: boolean }>;
  createdAt?: unknown;
  updatedAt?: unknown;
}

// null = quantity genuinely unknown (never confirmed against a real count)
// — distinct from 0 (confirmed sold out). Never treat null as 0 or as
// unlimited; see productVariants.ts's hasUnknownStock()/totalStock() and
// data/variants.ts for the shared helpers that handle this safely.
export type StockVariant = { size: string; qty: number | null; qtyUnknown?: boolean };

export interface AdminColorVariant {
  id: string;
  colorName: string;
  colorNameAr?: string;
  colorHex: string;
  imageId?: string;
  imageUrl?: string;
  gallery?: string[];
  // Display order (lower first) — colorVariants[0] is treated as "the
  // primary/default color" throughout the app (thumbnails, default
  // selection). Optional so every existing literal/fixture that predates
  // this field still typechecks unchanged; joinProductFields()/
  // normalizeProduct() (see productVariants.ts) always populate a real
  // number when reading from Firestore, falling back to array position
  // for a document that doesn't have one yet, so the array a consumer
  // actually sees is always sorted and colorVariants[0] always means what
  // it always has.
  order?: number;
  sizeStock: StockVariant[];
}

export interface AdminProduct {
  id: string;
  slug: string;
  // Optional printed barcode/SKU from the garment tag (UPC/EAN or an internal
  // code). Purely for POS scanner lookup — the terminal falls back to matching
  // on this when a scan doesn't match any slug. Nothing else depends on it, and
  // it is not required to be unique or present.
  sku?: string;
  name: string;
  nameAr?: string;
  category: string;
  price: number;
  compareAtPrice?: number;
  colorVariants: AdminColorVariant[];
  sizes: string[];
  tags?: ("new" | "bestseller" | "sale" | "limited")[];
  rating: number;
  reviewCount: number;
  description: string;
  descriptionAr?: string;
  details: string[];
  detailsAr?: string[];
  status: "active" | "archived" | "draft";
  images?: string[]; // product-level extra photos, shown next to the video in the editor
  videoUrl?: string; // product-level, not per-color — no per-color video association exists in the source data
  createdAt?: unknown;
  updatedAt?: unknown;
  // --- Legacy single-variant fields -----------------------------------
  // Present only on documents seeded before the multi-color-variant model.
  // Never written by current code — normalizeProduct() folds these into a
  // single colorVariants[0] entry at read time so old docs keep working
  // without a migration. Kept optional here purely so raw Firestore reads
  // typecheck before normalization.
  imageId?: string;
  imageUrl?: string;
  gallery?: string[];
  colorName?: string;
  colorNameAr?: string;
  colorHex?: string;
  stock?: StockVariant[];
}

export interface AdminCategory {
  id: string;
  slug: string;
  name: string;
  nameAr?: string;
  tagline: string;
  taglineAr?: string;
  imageId?: string;
  imageUrl?: string;
  // Key into CATEGORY_ICONS (src/components/ui/CategoryIcons.tsx) — see
  // that file's module comment for why keys are decoupled from slugs.
  icon?: string;
  // Display order (lower first) — the model's sortOrder. Kept as a single
  // global sequence in tree (depth-first) order, so a flat sort by `order`
  // and a tree walk both list categories the same way. See
  // src/data/categoryTree.ts's renumberTree().
  order: number;
  // Doc id of the parent category; unset/null = top level. `tagline` /
  // `taglineAr` double as the category's optional description.
  parentId?: string | null;
  // false = hidden from the POS and the storefront, still listed here in
  // admin. Unset counts as active, so docs written before this field
  // existed stay visible.
  isActive?: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}

// "ready" (Phase 3) sits between "processing" and "shipped": every order
// line has been confirmed prepared. It is derived automatically from
// AdminOrder.preparedLines (see orderPreparation.ts) and must never be a
// manually-selectable target -- see STATUSES.filter in OrderDetail.tsx and
// checkBulkStatusEligibility's own guard.
export type OrderStatus = "pending" | "processing" | "ready" | "shipped" | "delivered" | "cancelled" | "refunded" | "completed";

export interface OrderLine {
  productId: string;
  variantId: string;
  name: string;
  qty: number;
  price: number;
  size: string;
  color: string;
  imageId?: string;
  imageUrl?: string;
  // Optional, customer-authored, scoped to this exact line -- set in the
  // Cart Drawer before checkout (see CartLine.note), never a generic
  // order-level note. Absent (not an empty string) when the customer left
  // it blank; placeOrder() trims and omits it entirely in that case.
  note?: string;
}

export type PaymentMethod = "cash" | "card" | "split";

// Proof that the customer accepted the exchange/return policy shown at
// checkout, at the version it was shown. Web-only (undefined for POS sales,
// which are cashier-mediated and never show this) — see orderTransaction.ts.
// Written once, atomically with the order, never edited afterward.
export interface OrderPolicyConsent {
  policyVersion: number;
  lang: "en" | "ar";
  acceptedAt?: unknown;
}

export interface AdminOrder {
  id: string;
  orderNumber: string;
  customerId?: string;
  customerName: string;
  // Optional: Sisley's manual/off-site order workflow (OrderList.tsx's
  // "New Order" form) is built around name + phone, not email — many
  // in-person/phone customers don't have one. Web checkout and POS still
  // always populate this (POS as ""), so it stays a required field on
  // PlaceOrderInput in orderTransaction.ts; only this shared display type
  // needs to admit it can be absent.
  customerEmail?: string;
  customerPhone?: string;
  lines: OrderLine[];
  subtotal: number;
  shipping: number;
  discount?: number;
  // Set only for a web checkout that applied a code — ties `discount` back
  // to the real discounts/{id} doc it was re-derived from (see
  // orderTransaction.ts and firestore.rules' isValidDiscountForOrder).
  // Never set for a POS sale's manual, cashier-applied discount amount.
  discountId?: string;
  total: number;
  status: OrderStatus;
  // The delivery zone the customer selected at checkout (web orders only --
  // never set for POS, which charges no shipping at all; never set for a
  // manual/off-site order, whose shipping is a custom-entered figure with
  // no connection to the storefront's zones). `deliveryZoneName`/`NameAr`
  // are denormalized from the zone at the moment it was charged, the same
  // way OrderLine denormalizes product name/color -- so the order still
  // displays correctly even if the zone is later renamed or deleted.
  // Absent entirely on any order placed before this feature existed; that
  // is not an error state, just history predating the field (see
  // adminOrderEdit.ts for how editing such an order is handled).
  deliveryZoneId?: string;
  deliveryZoneName?: string;
  deliveryZoneNameAr?: string;
  // "manual": an order staff typed in by hand (OrderList.tsx's "New Order").
  // Absent on manual orders created before this value existed.
  source?: "web" | "pos" | "manual";
  // POS-only fields (source: "pos")
  // Multi-branch: where the sale was rung up. Name/code are snapshots, same
  // "denormalize, don't live-join" convention as OrderLine. Absent on any POS
  // sale made before branches existed, and on every web/manual order.
  branchId?: string;
  branchName?: string;
  branchCode?: string;
  registerId?: string;
  registerName?: string;
  paymentMethod?: PaymentMethod;
  cashAmount?: number;
  cardAmount?: number;
  registerSessionId?: string;
  // POS device sales only: the staff member who started the shift (copied
  // from the session's operatorId). cashierUid is then the device itself.
  operatorId?: string;
  shippingAddress?: string;
  notes?: string;
  policyConsent?: OrderPolicyConsent;
  // Set when the delivery company could not deliver this package and
  // returned it to Sisley — a distinct, order-level fact independent of
  // OrderStatus (the order's lifecycle stage) and independent of the
  // Returns Shelf (AdminReturn: a specific product the customer DID
  // receive and is sending back). Owner/admin only, one-way (never
  // unflagged once set — see firestore.rules). Queried by OrderList.tsx's
  // "New Order" form to warn staff about a customer's non-delivery history.
  nonDeliveryFlagged?: boolean;
  nonDeliveryNote?: string;
  nonDeliveryMarkedBy?: string;
  nonDeliveryMarkedByName?: string;
  // Phase A: added alongside the pre-existing email/name snapshot fields
  // above -- uid is the authoritative identity (enforced in firestore.rules
  // against request.auth.uid), email/name stay as display snapshots.
  // Absent on any record written before this field existed.
  nonDeliveryMarkedByUid?: string;
  nonDeliveryMarkedAt?: unknown;
  // --- Legacy, order-level Branch Stock Note (superseded by
  // lineBranchStockNotes below) -------------------------------------------
  // No longer written or read by any current code path -- a single note for
  // the whole order couldn't say WHICH product it was about once an order
  // had more than one line, which is exactly why this was replaced by a
  // per-line-item note. Kept here, untouched, only so a historical order
  // that still carries one doesn't error and its old value is never
  // silently deleted -- there is no migration/backfill into the new field.
  branchStockNote?: string;
  branchStockNoteUpdatedBy?: string;
  branchStockNoteUpdatedByName?: string;
  branchStockNoteUpdatedByUid?: string;
  branchStockNoteUpdatedAt?: unknown;
  // Free-text internal note for coordinating between Sisley branches when a
  // SPECIFIC product/line in this order isn't in stock at the branch
  // preparing it but is available at another branch. Keyed by
  // returnLineKey(productId, variantId, size) -- same key shape
  // preparedLines/preparedLineMeta below already use to identify one line.
  // Deliberately separate from `notes` above, which for a web order is the
  // CUSTOMER's own delivery instructions from checkout — writing here must
  // never touch that field. Edited directly on the line item itself
  // (OrderDetail.tsx's small note icon -> compact inline editor), not on a
  // separate page. Owner/admin/cashier can all write this one narrow field
  // (see firestore.rules); editing it does not grant any other order access.
  lineBranchStockNotes?: Record<
    string,
    { note: string; updatedByUid: string; updatedByEmail: string; updatedByName: string; updatedAt: unknown }
  >;
  // Phase 3 preparation state: keyed by returnLineKey(productId, variantId,
  // size) (same key shape returnsHelpers.ts already uses to identify a
  // line), true once an employee has confirmed that line's full requested
  // quantity as physically gathered. Absent entirely on every historical
  // order (and absent per-key for any line never touched) -- both read as
  // unconfirmed, never as an error; see orderPreparation.ts. Never read or
  // written by checkout/POS/stock/returns/cancellation logic.
  preparedLines?: Record<string, boolean>;
  // Phase A: per-line "who/when confirmed or reset this line" metadata,
  // keyed identically to preparedLines. Purely additive/informational --
  // preparedLines above remains the SOLE source of truth for whether a
  // line counts as confirmed (see admin/orderPreparation.ts); this is never
  // read for that decision, only for display. Absent entirely on any
  // order/line that predates this field or was never touched -- no
  // migration, no backfill.
  preparedLineMeta?: Record<string, { prepared: boolean; byUid: string; byEmail: string; byName: string; at: unknown }>;
  createdAt?: unknown;
  updatedAt?: unknown;

  // ---- Phase A: direct employee action attribution -----------------------
  // Every field below is additive and optional -- absent entirely on any
  // order predating this feature (not an error state, just history). `uid`
  // is always the authoritative identity (enforced in firestore.rules
  // against request.auth.uid wherever the field is present); email/name are
  // point-in-time display snapshots, never a live join to the employee's
  // current profile. Never backfilled/invented for historical orders.

  // Set whenever a staff member changes this order's status (single or
  // bulk), including the automatic status change preparation confirm/reset
  // can trigger (see admin/orderPreparation.ts's
  // deriveStatusAfterPreparationChange). Reflects the LAST status change
  // only, not a full history -- see activityLogs for a chronological trail.
  statusUpdatedByUid?: string;
  statusUpdatedByEmail?: string;
  statusUpdatedByName?: string;
  statusUpdatedAt?: unknown;
  // Set when a staff member cancels this order via
  // cancelOrderAndRestoreStock() -- written atomically in the same
  // transaction as the cancellation and any stock restoration.
  cancelledByUid?: string;
  cancelledByEmail?: string;
  cancelledByName?: string;
  cancelledAt?: unknown;
  // Set whenever a staff member edits this order's line items via
  // updateOrderLines() -- written even when the edit doesn't change any
  // quantity that would produce a stockMovements entry (e.g. a note-only or
  // size-swap-at-equal-qty edit).
  linesUpdatedByUid?: string;
  linesUpdatedByEmail?: string;
  linesUpdatedByName?: string;
  linesUpdatedAt?: unknown;
  // Set whenever a staff member saves this order's internal note (the
  // free-text `notes` field, Internal Information page). A single current
  // note, matching the existing one-note-field design -- not a history log.
  internalNoteUpdatedByUid?: string;
  internalNoteUpdatedByEmail?: string;
  internalNoteUpdatedByName?: string;
  internalNoteUpdatedAt?: unknown;
  // Set whenever a staff member edits this order's customer/shipping
  // details from the dedicated Customer & Shipping page. Never set for a
  // customer editing their own storefront account/address data -- that is
  // a completely separate, unrelated data path (see AccountAddresses.tsx),
  // not a staff-side order edit.
  customerShippingUpdatedByUid?: string;
  customerShippingUpdatedByEmail?: string;
  customerShippingUpdatedByName?: string;
  customerShippingUpdatedAt?: unknown;
  // Set only for a manual/off-site staff order (OrderList.tsx's "New
  // Order" form) -- never for a genuine web/storefront checkout, which has
  // no employee involved at all. Distinguishes "which employee typed this
  // order in" from the existing `createdAt` (when), which every order
  // already has. POS sales use `cashierUid`/`cashierEmail`/`cashierName`
  // below instead (a POS sale's "creator" and "cashier" are the same
  // concept, so it isn't duplicated under both names).
  createdByUid?: string;
  createdByEmail?: string;
  createdByName?: string;
  // POS-only: the cashier who rang this specific sale, stored directly on
  // the order itself (previously only reconstructable indirectly via
  // registerSessionId -> registerSessions.cashierId, or via the adjacent
  // stockMovements actor fields). Never set for a web checkout or a
  // manual/off-site order.
  cashierUid?: string;
  cashierEmail?: string;
  cashierName?: string;
  // Delivery-company (Olivery/UnitedExp) Create Order integration state --
  // see src/firebase/deliveryOrder.ts / src/admin/deliveryOrderMapping.ts.
  // `deliverySendingAt` is a short-lived claim set transactionally right
  // before the outbound request is made and cleared again if that request
  // fails, so a second, concurrent trigger can't create a second delivery
  // order while the first attempt is still in flight. `deliverySentAt` is
  // set only once a request has actually succeeded, and is the durable
  // guard the UI checks to avoid ever sending the same order twice.
  // `deliveryReferenceId` is exactly what THIS system sent as the API's own
  // `reference_id` (a deterministic numeric derivation of orderNumber --
  // see deriveNumericReferenceId -- NOT orderNumber itself, which the real
  // API rejects; see that function's own comment).
  //
  // `deliveryUnitedOrderId` / `deliverySequence` (2026-09-30, replacing the
  // old single `deliveryExternalId` field): CONFIRMED LIVE against United's
  // real test account that a successful create_order response returns TWO
  // distinct identifiers -- `id` (United's own internal numeric order id)
  // and `Sequence` (a separate tracking/label number, e.g. "UE2495670") --
  // never collapsed into one field, since they serve different purposes
  // (id for API lookups via the /order endpoint, Sequence for what staff
  // would actually read off a printed label / quote to the courier).
  deliverySendingAt?: unknown;
  deliverySentAt?: unknown;
  deliverySentByUid?: string;
  deliverySentByEmail?: string;
  deliverySentByName?: string;
  deliveryReferenceId?: string;
  deliveryUnitedOrderId?: string;
  deliverySequence?: string;
}

// A returned unit is never re-added to product.colorVariants.sizeStock.qty
// until an admin/owner explicitly resolves it as "good" — see
// src/firebase/returnsTransaction.ts. "quarantine" -> inspect -> either
// "resolved" (good: stock restored / damaged: stock never restored) or
// "needs_repair" (stays excluded until re-inspected, then resolved the
// same way). "resolved" is terminal — no reopen in v1.
export type ReturnReason =
  | "defective"
  | "wrong_size"
  | "wrong_color"
  | "changed_mind"
  | "fulfillment_error"
  | "shipping_error"
  | "other";
export type ReturnStatus = "quarantine" | "needs_repair" | "resolved";
export type ReturnDisposition = "good" | "damaged" | null;

export interface AdminReturn {
  id: string;
  orderId: string;
  orderNumber: string;
  customerId?: string;
  customerName: string;
  customerEmail: string;
  // Denormalized from the order line at intake time (the historical sale
  // record), not re-read live from the product — a later catalog edit
  // must never rewrite what this return says was actually sold/returned.
  productId: string;
  productName: string;
  variantId: string;
  colorName: string;
  size: string;
  sku?: string;
  qty: number;
  reason: ReturnReason;
  reasonNote?: string;
  photos?: string[];
  status: ReturnStatus;
  disposition: ReturnDisposition;
  inspectionNotes?: string;
  processedBy: string;
  processedByName: string;
  // Phase A: added alongside the pre-existing email/name snapshots above --
  // uid is authoritative (enforced in firestore.rules against
  // request.auth.uid), email/name stay as display snapshots. Optional only
  // because it's absent on any return logged before this field existed.
  processedByUid?: string;
  resolvedBy?: string;
  resolvedByName?: string;
  resolvedByUid?: string;
  resolvedAt?: unknown;
  // True only once product stock has actually been incremented for this
  // return — guards against a double restock.
  restocked: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}

// Permanent, append-only record of every quantity change to a single
// (product, variant, size) cell. Written inside the SAME transaction as the
// stock change it describes wherever that change is already transactional
// (checkout, admin order-line edits, return resolution) — see
// src/admin/stockMovements.ts's computeStockDeltas() and firestore.rules'
// stockMovements/{id} block. Deliberately NOT a duplicate of
// ActivityLogEntry: that collection is a best-effort, human-readable "who
// did what" trail (fire-and-forget, errors swallowed); this one is a
// structured numeric ledger where completeness is the entire point.
export type StockMovementReason = "sale" | "order_edit" | "return_restock" | "manual_adjustment" | "initial_stock" | "order_cancelled" | "stock_received" | "branch_transfer";
export type StockMovementSource = "web" | "pos" | "admin";

// Why an admin changed a count by hand (manual_adjustment from the product
// page's Edit stock popup). Free-text detail goes in StockMovement.note.
export const STOCK_ADJUSTMENT_REASONS = ["recount", "received", "damaged", "lost", "transfer", "correction", "other"] as const;
export type StockAdjustmentReason = (typeof STOCK_ADJUSTMENT_REASONS)[number];

export interface StockMovement {
  id: string;
  productId: string;
  // Denormalized snapshots, not live references — a later product rename
  // or deletion must never rewrite what history says actually happened.
  productName: string;
  variantId: string;
  colorName: string;
  size: string;
  // qty: null (never confirmed) is always floored to 0 for both sides
  // before a movement is recorded — see computeStockDeltas().
  qtyBefore: number;
  qtyChange: number; // signed: negative = sold/removed, positive = added back
  qtyAfter: number;
  reason: StockMovementReason;
  source: StockMovementSource;
  // Absent for a web-checkout sale — that's placed by an arbitrary signed-
  // in-or-anonymous shopper, and attributing it to a staff identity would
  // be dishonest. `source` itself is the true answer to "who did this" for
  // that case. Present for every admin/cashier-initiated reason.
  actorUid?: string;
  actorEmail?: string;
  actorName?: string;
  orderId?: string;
  orderNumber?: string;
  returnId?: string; // present only for reason: "return_restock"
  // Set when the movement changed a branch's stock (branchStock/{id}) rather
  // than the product's own online stock. Absent = online stock.
  branchId?: string;
  // POS sales: the register (till) the sale was rung up on.
  registerId?: string;
  registerName?: string;
  // "stock_received" (Add stock): every movement written by one receipt
  // shares its receiptId; reference is the admin-entered supplier
  // invoice/delivery number, note the free-text reason.
  receiptId?: string;
  reference?: string;
  note?: string;
  adjustmentReason?: StockAdjustmentReason;
  // No updatedAt, deliberately — a field named "last updated" has no place
  // on a document that must never be updated (see firestore.rules).
  createdAt?: unknown;
}

export type RegisterSessionStatus = "open" | "closed";

export interface RegisterSession {
  id: string;
  cashierId: string;
  cashierName: string;
  // POS device shifts only: the staff member who picked their name when
  // starting the shift (cashierId is then the device's own identity).
  operatorId?: string;
  // Multi-branch: which branch/register this session runs on. Frozen once
  // opened (see firestore.rules). Absent only on sessions opened before
  // branches existed.
  branchId?: string;
  branchName?: string;
  branchCode?: string;
  registerId?: string;
  registerName?: string;
  startingCash: number;
  status: RegisterSessionStatus;
  salesCount: number;
  cashTotal: number;
  cardTotal: number;
  discountTotal: number;
  grossTotal: number;
  // Running total of cash taken out of the drawer during the shift (see
  // CashMovement). Absent on sessions from before withdrawals existed.
  cashOutTotal?: number;
  countedCash?: number;
  expectedCash?: number;
  variance?: number;
  openedAt?: unknown;
  closedAt?: unknown;
  // Phase A: the employee who actually performed the close -- distinct
  // from cashierId/cashierName above, which record only who OPENED the
  // session and are frozen thereafter (see firestore.rules). Today's UI
  // only ever lets a cashier close their own open session, so opener and
  // closer are typically the same person, but that is a UI choice, not a
  // guarantee this field encodes -- it always reflects whoever actually
  // triggered closeRegister(). Absent on any session closed before this
  // field existed.
  closedByUid?: string;
  closedByEmail?: string;
  closedByName?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

// Cash taken out of a till's drawer during an open shift (a pay-out, a
// bank drop...). Immutable once written; the session's cashOutTotal is
// raised in the same transaction (see recordCashWithdrawal()).
export interface CashMovement {
  id: string;
  sessionId: string;
  branchId: string;
  registerId: string;
  type: "withdrawal";
  amount: number;
  reason?: string;
  actorUid: string;
  actorName: string;
  createdAt?: unknown;
}

// A single free-text delivery address, matching the exact shape Checkout.tsx
// has always used (one textarea, no street/city/postal breakdown) — kept
// deliberately unstructured rather than inventing fields checkout doesn't
// have anywhere to autofill. `deliveryZoneId` is optional so a saved
// address created before delivery zones existed doesn't break -- Checkout.tsx
// requires the customer to pick a zone before checkout either way, and
// AccountAddresses.tsx lets them fill in the missing zone on an old address.
export interface CustomerAddress {
  id: string;
  address: string;
  deliveryZoneId?: string;
  isDefault: boolean;
}

export interface AdminCustomer {
  id: string;
  // Set only for a self-registered shopper account, and always equal to the
  // Firestore doc id in that case (the doc id IS the Firebase Auth uid, the
  // same "one collection, dual-purpose" pattern admins/{uid} already uses).
  // Absent for CRM leads an admin added manually — those keep a random id.
  uid?: string;
  authProvider?: "google" | "password";
  photoURL?: string;
  name: string;
  email: string;
  phone?: string;
  ordersCount: number;
  totalSpent: number;
  tags?: string[];
  notes?: string;
  // Self-serve only (identified customers writing their own doc — see
  // firestore.rules); never set for guests, and never touched by admin CRM
  // tooling or historical order snapshots.
  addresses?: CustomerAddress[];
  createdAt?: unknown;
  updatedAt?: unknown;
}

export type DiscountType = "percent" | "fixed";

export interface AdminDiscount {
  id: string;
  code: string;
  type: DiscountType;
  value: number;
  active: boolean;
  startsAt?: string;
  expiresAt?: string;
  usageLimit?: number;
  usageCount: number;
  minSubtotal?: number;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export type ReviewStatus = "pending" | "approved" | "rejected";

export interface AdminReview {
  id: string;
  productId: string;
  productName: string;
  author: string;
  email?: string;
  rating: number;
  title?: string;
  body: string;
  status: ReviewStatus;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export type MediaType = "image" | "video";

export interface MediaAsset {
  id: string;
  name: string;
  url: string;
  path: string;
  type: MediaType;
  size: number;
  width?: number;
  height?: number;
  tags?: string[];
  createdAt?: unknown;
}

export interface ActivityLogEntry {
  id: string;
  // Phase A: the authoritative identity -- enforced in firestore.rules to
  // equal request.auth.uid on every new entry (see logActivity.ts). Optional
  // only because it's absent on every entry written before this field
  // existed; treat a missing value as "predates this feature," never as an
  // error or as license to fall back to trusting actorEmail/actorName alone.
  actorUid?: string;
  actorEmail: string;
  actorName: string;
  action: string;
  target: string;
  details?: string;
  createdAt?: unknown;
}

export type NotificationKind = "low_stock" | "new_order" | "new_review" | "system";

export interface AdminNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  read: boolean;
  link?: string;
  createdAt?: unknown;
}

export interface HeroSlideContent {
  id: string;
  type: "image" | "video";
  src: string;
  // Set automatically when the video was picked via the product video
  // library (the source product's own photo) — never a separate upload.
  poster?: string;
  alt: string;
  badge?: string;
  badgeAr?: string;
  title?: string;
  titleAr?: string;
  subtitle?: string;
}

export interface PromoBanner {
  id: string;
  title: string;
  titleAr?: string;
  subtitle?: string;
  ctaLabel?: string;
  ctaLabelAr?: string;
  ctaHref?: string;
  imageUrl?: string;
  active: boolean;
  order: number;
}

// A fixed set of 4 slots (shipping/returns/fabrics/rating) — the admin can
// edit each one's text and toggle it on/off, but never add, remove, or
// reorder them; `id` is what maps a slot back to its (non-editable) icon.
export type ValueStripItemId = "shipping" | "returns" | "fabrics" | "rating";

export interface ValueStripItem {
  id: ValueStripItemId;
  text: string;
  textAr: string;
  active: boolean;
}

export interface HomepageContentDoc {
  heroSlides: HeroSlideContent[];
  banners: PromoBanner[];
  featuredProductIds: string[];
  promoBarText?: string;
  promoBarActive: boolean;
  // Optional — absent on documents saved before this field existed (and on
  // the live document today); the storefront and admin both fall back to
  // DEFAULT_VALUE_STRIP (src/data/valueStrip.ts) when it's missing, so no
  // migration is required.
  valueStrip?: ValueStripItem[];
}

export interface GeneralSettingsDoc {
  siteName: string;
  tagline: string;
  currency: string;
  maintenanceMode: boolean;
}

export interface AppearanceSettingsDoc {
  colorTheme: string;
  customColor?: string;
  fontDisplay: string;
  fontSans: string;
  logoUrl?: string;
  defaultTheme: "light" | "dark" | "system";
  allowUserThemeOverride: boolean;
}

export interface LanguageSettingsDoc {
  defaultLanguage: "en" | "ar";
  arabicEnabled: boolean;
}

export interface SeoSettingsDoc {
  metaTitle: string;
  metaDescription: string;
  ogImageUrl?: string;
  keywords?: string;
  robotsIndex: boolean;
}

export interface ContactSettingsDoc {
  email: string;
  phone: string;
  address: string;
  instagram?: string;
  tiktok?: string;
  pinterest?: string;
  facebook?: string;
}

// Standard/Express delivery methods were removed in favor of per-city/region
// delivery zones (see DeliveryZone below) -- Sisely never actually offered
// two delivery speeds, only different destinations. freeShippingThreshold
// and returnWindowDays are the two settings that were never method-specific
// to begin with, so they're preserved unchanged. freeShippingThreshold's
// calculation is still applied (a subtotal at/above it still zeroes the
// delivery fee, same as before), it is simply no longer advertised to the
// customer as a promotional message -- see Checkout.tsx.
export interface ShippingSettingsDoc {
  freeShippingThreshold: number;
  returnWindowDays: number;
}

// A single delivery city/region an admin manages, mirroring AdminDiscount's
// shape (id/name/nameAr/active). Stable `id` is what orders reference
// (never the Arabic display name, which can be edited later) -- see
// AdminOrder.deliveryZoneId. `sortOrder` drives display order in both the
// admin list and the checkout dropdown; two zones may share a value with no
// error, they just fall back to whatever stable order the query/sort
// returns. The old Sisley system's "fee based on purchase value" per-zone
// conditional pricing is deliberately NOT modeled here -- explicitly out of
// scope for this feature (see the 2026-09 city/region delivery-fee plan);
// `fee` is always a single fixed amount.
export interface DeliveryZone {
  id: string;
  name: string;
  nameAr: string;
  fee: number;
  active: boolean;
  sortOrder: number;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface PaymentSettingsDoc {
  acceptedMethods: string[];
  checkoutNote: string;
}

export interface SearchSettingsDoc {
  availableTagFilters: string[];
  synonyms: Record<string, string>;
}

// Merchant-editable exchange/return policy shown as a required consent step
// at checkout (see src/components/checkout/ExchangePolicyModal.tsx). `points`/
// `pointsAr` are the bulleted conditions, one entry per line. `version` is a
// plain incrementing counter (bumped on every save, not semantic) so an
// order's stored policyConsent.policyVersion can be traced back to the
// content that was actually shown, without needing to snapshot the full text
// onto every order.
export interface ExchangePolicySettingsDoc {
  enabled: boolean;
  title: string;
  titleAr: string;
  subtitle: string;
  subtitleAr: string;
  points: string[];
  pointsAr: string[];
  version: number;
  updatedAt?: unknown;
}

export interface NotificationPrefsDoc {
  lowStockAlerts: boolean;
  lowStockThreshold: number;
  newOrderAlerts: boolean;
  newReviewAlerts: boolean;
}

// --- Website analytics ------------------------------------------------
// Written directly by anonymous storefront visitors (see src/analytics/
// track.ts) — no personal data, just counters and a random per-tab id.

export interface AnalyticsDailyDoc {
  id: string; // YYYY-MM-DD
  date: string;
  pageviews?: number;
  visits?: number;
}

export interface ProductStatsDoc {
  id: string; // productId
  views?: number;
  quickAdds?: number;
}

export interface CategoryStatsDoc {
  id: string; // category slug
  views?: number;
}

export interface ProductViewDailyDoc {
  id: string; // `${date}_${productId}`
  date: string;
  productId: string;
  views?: number;
  quickAdds?: number;
}

export interface CategoryViewDailyDoc {
  id: string; // `${date}_${category}`
  date: string;
  category: string;
  views?: number;
}
