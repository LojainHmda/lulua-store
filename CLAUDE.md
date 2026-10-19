# Lulua store — notes for Claude

- App: React + Vite (`src/`), admin at `/admin`, POS at `/pos`.
- Backend: `services/api` (Hono on Postgres/Neon). It stores Firestore-style
  documents and enforces the security rules in `services/api/src/rules/index.ts`
  on every read and write. A feature that writes new collections/fields usually
  needs a rule change there, and the API must be redeployed with it.
- `.env.local` `DATABASE_URL` is the LIVE Neon database. For tests use PGlite:
  leave `DATABASE_URL` unset or use `pglite://<dir>`.
- Tests: `npm run test:rules` (rules + real transactions against in-process API on
  PGlite, no emulator needed), `npm run test:unit`, `npx tsc -b`.
- Known pre-existing failure: `tests/unit/sellabilityCoverage.test.ts` "the POS grid,
  search, category filter and scan all work from the sellable list".

## DEVLOG

### 2026-10-18 — Feature 1: POS Returns
- Till screen `src/pos/Returns.tsx` (route `/pos/<branch>/<register>/returns`, header
  "Returns"): find the sale by receipt number (typed, keyboard-wedge or camera scan;
  sale receipts now carry the sale-number barcode) or by scanning the item (this
  branch's recent sales of it), or no-receipt when the policy allows.
- One transaction `processPosReturn()` (`src/firebase/posReturn.ts`): immutable
  `posReturns/{id}` record, shared `returnCounters` (no unit returned twice, also
  across the online returns flow), sale refund totals (`refundedTotal/Cash/Card`,
  `refundStatus`), receiving-branch `branchStock` + `return_restock` ledger rows for
  resellable lines (damaged lines are not restocked), shift refund totals. Idempotent
  per return id (retries never refund twice).
- Money: per-line refund = line's share of the paid total (discount spread by value,
  exact to the cent across partial returns) — `src/admin/posReturns.ts`. Card refund
  capped by card paid on the sale; cash refund capped by drawer.
  `sessionExpectedCash` now subtracts `cashRefundTotal`.
- Rules: new `posReturns`; cashier may raise branch stock / sale refund fields /
  write restock ledger rows only together with a return created in the same commit;
  window and no-receipt policy enforced server-side. Cashiers can now `get` any POS
  sale by id or query it by `orderNumber` (cross-branch returns); listing other
  branches' sales is still denied.
- Policy: Admin → Settings → POS Returns (`settings/posReturns`: return days, allow
  no-receipt, non-returnable categories).
- Reporting: refunds on Today's sales, Close register, shift detail, admin POS Sales
  (Refunds, Net sales, per-branch, Returns table + detail/reprint), order page.
  Admin "Process Return" (online flow) is hidden for POS sales.
- Layout follows the till: category rail + product grid (tap a tile = scan the item),
  right panel "This return" like "Current sale" with steppers, condition and negative
  amounts; sale view replaces the grid once a sale is opened; no-receipt size picker is a popup.
- Returns grid lists only products on still-returnable POS sales from ALL branches
  (`listReturnableSales`: not cancelled, not fully returned, within the return period or
  90 days without one). Tapping one opens a size/qty picker like the till's and adds it
  straight to "This return"; the units are taken from a real sale (the one already on the
  return, else this branch's newest, else any branch's) and the grid then shows that sale's items. Rule: cashiers may
  list other branches' POS sales only with a `createdAt >=` bound inside that period.
- Sales carry `returnedByLine` (units returned per line, = the returnCounters, checked by the
  rules); the Returns grid hides an item once all its units are returned, even if other items
  on that receipt remain. Older sales without it are read from their counters.
- Return panel bottom = total + "Refund" button only; reason, note, refund method (cash/
  card/split) and the amounts are in the refund dialog, like the till's payment dialog.
- POS header: fixed Sale | Returns | Today's sales switch. The till's unfinished cart is
  kept per shift in sessionStorage (`lulua-pos-cart:<sessionId>`), so switching screens or
  refreshing doesn't lose it.
- Admin → Point of Sale → Returns (`/admin/pos-returns`, owner/admin): all returns with
  date/branch/register/cashier/method/receipt filters, search, totals, detail + receipt.
  Date-range helpers shared with POS Sales in `src/admin/posDateRange.ts`.
- Tests: `tests/rules/pos-returns.test.ts`, `tests/unit/posReturns.test.ts`.

### 2026-10-18 — Feature 2: Clear Cart
- Till sale panel: trash icon ("Clear cart" tooltip/label) in the panel header next to the
  expand/full-screen icons, in wine colour; hidden while the payment dialog is open and when
  the cart is empty.
- 1 unit clears at once; 2+ units ask first ("Remove all N items (total)?"). Clearing resets
  the cart, discount, payment method, tendered cash and split (`resetSale`) and the saved
  cart in sessionStorage. No stock or sale record is touched (none exists before Complete).
- Logged to the activity log as `pos.cartCleared` (units · total) for void tracking.

### 2026-10-18 — Feature 3: Discount in the payment popup
- Discount editor moved from the sale panel into the payment popup (top block: Subtotal →
  Discount (manual) → Total). % or ₪, quick 5/10/15/20% chips (only those within the limit),
  "Max N% (₪)" hint, remove ×; invalid/over-limit values block Complete sale. The sale panel
  only shows the discount line. Changing the discount resets cash tendered / split card.
- Permission: owner/admin unlimited; cashiers up to `settings/posDiscounts.cashierMaxPercent`
  (default 10, 0 = off) — Admin → Settings → POS Discounts. Before this, discounts were
  owner/admin-only, and owner/admin never sell on the till, so no discount was usable.
- Rules (`isValidCashierDiscount`): a cashier's sale discount must be "manual", ≤ limit % of the
  claim's real subtotal (the order's subtotal can't be inflated), total = subtotal − discount.
- Sale stores `discountSource: "manual"` and `discountPercent`; receipt shows
  "Discount (manual 10%)"; activity log `pos.discountApplied`; shift discountTotal as before.
- Admin → Point of Sale → Discounts (`/admin/pos-discounts`, owner/admin): the cashier limit
  (moved here from Settings — the only place it's set) + report of discounts given (KPIs,
  per-cashier table, discounted sales list) with date/branch/register/cashier filters.
- Tests: pos-branches rules test (limits), `tests/unit/posDiscounts.test.ts`.

### 2026-10-18 — Feature 6: Promotions (automatic discounts), built early at the user's request
- Admin → Point of Sale → Discounts → **Promotions** tab: list (offer, applies to, branches,
  dates, Live/Scheduled/Ended/Off, what each gave in the period), on/off toggle, edit, delete,
  editor (`src/admin/components/PromotionsManager.tsx`). Types: % off, ₪ off (each item, or off
  the sale), Buy X get Y (at Z% off, 100 = free), bundle "any N for ₪". Applies to products,
  categories (sub-categories included, resolved to `categorySlugs` on save) or the whole sale
  (% / ₪, optional minimum). Branches (empty = all), start/end date-time. `promotions/{id}`.
- ONE calculator `services/api/src/shared/promotions.ts` (re-exported by `src/data/promotions.ts`)
  used by the till, `placeOrder` and the rules. Combining: one item promotion per line (biggest
  saving first, each takes its unclaimed lines), then one whole-sale promotion on what's left,
  then the cashier's manual discount (limit % now measured on the total after promotions).
- Till: live promotions (subscribed, re-evaluated each minute for start/end); line tag + struck
  price, "Promo: name -X" rows in panel and payment popup, receipt rows. `placeOrder` reloads
  live promotions and re-runs the calculator on real prices; if the total differs from what the
  screen showed → `PromotionsChangedError` (nothing written).
- Sale: `promoDiscount`, `manualDiscount`, `promotions[{id,name,amount}]`, `discount` = both,
  `discountSource` manual|promotion|mixed, lines[].promoDiscount/promotionId/promotionName.
  `saleLineNets` keeps a line's own promo on that line (refunds exact).
- Rules: `promotions` admin-write/all-staff-read (+ basic validation); `isValidCashierDiscount`
  re-runs the calculator with the cited promotions (must exist & be live for the branch) on the
  claim's prices and requires exact per-line / per-promotion / total amounts.
- Manual tab of the Discounts page splits totals into "By promotions" / "Manual (cashiers)".
- "Almost there" hints (`promotionHints`): the till shows e.g. "<name>: add 1 more to get 1 free"
  when a buy-X-get-Y / bundle deal is short of a full group (a 2+1 with 2 items gives nothing).
  Promotions list status refreshes every 15 s.
- Tests: `tests/unit/promotions.test.ts`, promotion cases in `tests/rules/pos-branches.test.ts`.

### 2026-10-19 — Dark mode: black instead of warm brown
- `src/index.css` `.dark` neutrals switched to a neutral black/grey scale (page #0a0a0a, cards
  #171717, borders #2a2a2a, text #f5f5f5/#a3a3a3/#737373; sand/stone greys). Accent colours
  (wine, olive) unchanged.

### 2026-10-19 — Feature 4: Hold / Park Sale
- Till: pause icon in the sale panel header holds the sale in one tap (no dialog, per user) →
  `heldSales/{id}` (ref `H-XXXXX`, lines, subtotal, manual discount, branch/register/shift/
  cashier), cart cleared. No sale record, no stock change. "Held sales (N)" button beside the
  scanner lists the BRANCH's held sales (ref, time, register, cashier, customer, items, total)
  with Resume / Discard. `src/firebase/heldSales.ts`.
- Resume = one transaction held → resumed (second till gets "Already taken by X"). Cart is
  rebuilt with TODAY's prices and this till's stock: removed/out-of-stock lines dropped, qty
  capped, price changes listed in a "some things changed" dialog. Resuming with a non-empty cart
  holds the current sale automatically first, then opens the chosen one (no popup, never overwrites).
- Shift close: held sales stay with the branch (any till can resume); Close register shows how
  many this shift left and can discard them. Older than 24 h = expired: discard only (rule-
  enforced, `HELD_SALE_TTL_MS`).
- Rules `heldSales`: create from own open shift at own branch; branch staff read; only
  held→resumed (by self, within 24 h) or held→cancelled, no content edits; admin delete.
- Activity log: `pos.saleHeld`, `pos.saleResumed`, `pos.heldSaleDiscarded`.
- Tests: `tests/rules/held-sales.test.ts`.

### 2026-10-19 — Feature 5: Offline mode
- Till keeps selling when the connection drops. "Online" = browser online AND server answering
  (`src/pos/offline/OfflineContext.tsx`; a failed request flips it, a check every 5 s flips it back).
  `listen()` in `src/db/firestore.ts` keeps the last data and retries on "unavailable" (products,
  stock, promotions stay on screen).
- Offline sale: saved in IndexedDB (`lulua-pos-offline`/`sales`, `offlineStore.ts`) with its final
  order id + number, receipt marked "Offline sale"; till stock shown minus waiting sales.
  Strip under the header (`OfflineBanner.tsx`): offline / sending / waiting / needs review + details.
- Sync (`sync.ts`): automatic when back online, oldest first, via `placeOrder` with `orderId`,
  `orderNumber`, `offline:{createdAt,linePrices}` — idempotent (an id already recorded is skipped),
  prices as sold, promotions judged at the sale time, order `createdAt` = sale time, `syncedAt`.
  Stock may go below zero for offline sales only (claim `offline:true`); recorded in
  `stockShortage[]`. A refused sale stays on the device and is reported to `posSyncIssues/{id}`.
- Rules: negative branch stock only with `claim.offline`; promo liveness at `offlineCreatedAt`
  (≤ 7 days back, ≤ 5 min ahead); cashier may `get` a missing order (to check "already sent");
  `posSyncIssues` (till creates own open issue for its branch, admin resolves); admin may set
  `shortageReviewed*` on an offline order.
- Offline: Hold, Held sales, Returns lookup, cash withdrawal, Close register are disabled; Close
  register also waits until this shift's offline sales are sent; sign-out blocked while waiting.
  After close, reported issues of that shift are removed from the device.
- Admin → POS Sales: "Offline sales to review" card (refused sales + stock shortages) with
  "Mark resolved / reviewed" + note (`OfflineSalesReview.tsx`), activity `pos.offlineIssueResolved`.
- Limitation: the till must be opened online (a reload while offline won't load the app);
  waiting sales are sent once it's open online again.
- Tests: `tests/unit/offlineSync.test.ts`, "offline till sales" in `tests/rules/pos-branches.test.ts`.

### 2026-10-19 — Feature 9: End-of-day snapshot
- Admin → Branches → each branch card "End of day" → `/admin/branches/<branchId>/day[?date=yyyy-mm-dd]`
  (`src/admin/pages/BranchDay.tsx`, owner/admin). Day picker (‹ date ›, Today), Print (opens a
  print window of the report).
- Figures (`src/admin/daySnapshot.ts`, `buildDayFigures`): sales of the branch created that day
  (offline ones on the day made, cancelled excluded), refunds taken in at the branch that day,
  payments cash/card, discounts (promo/manual), net; cash drawer from the shifts OPENED that day
  (starting + cash sales − cash refunds − withdrawals = expected, counted, difference); shifts
  table (click = shift detail), tills, cashiers, top 10 products, sales by hour, stock now
  (today only: units, sold out, below zero).
- "Close day" (blocked while any of the branch's tills is still open) freezes the figures into
  `branchDaySnapshots/<branchId>__<date>` (+ note, closedBy, version); the page then shows the
  saved snapshot. If the data changes later (late offline sale, forced close) a banner shows
  saved vs now and "Close again" saves the next version. Activity `branch.dayClosed`.
- Rules: owner/admin read/create/update (id = branch__date, closedByUid = self, closedAt = now,
  version 1 then +1, branch/date fixed); owner delete.
- Tests: `tests/unit/daySnapshot.test.ts`, `tests/rules/day-snapshots.test.ts`.

### 2026-10-19 — Feature 10: POS Reports (Branch → Till → Day → Shift)
- Separate page in its own sidebar section Reports → Sales reports (`/admin/pos-reports`, owner/admin,
  `src/admin/pages/PosReports.tsx`). Date range (today/yesterday/7 days/month/custom) + drill
  down: all branches → a branch's tills → a till's days → that day's shifts → the shift's sales
  (receipt links, offline/returned tags) and returns. Path in the URL (`?range&from&to&b&r&d&s`)
  so back/links work; breadcrumb jumps back to any level; "End of day" link at day level.
- Every level: no. of sales, items, sales, discounts, refunds, net, cash, card, avg, shifts,
  cash difference (counted shifts only; "—" while only open shifts), with a Total row and KPI
  tiles. One aggregator `src/admin/posReports.ts` (`aggregate(level, …)`, `total`) so each level
  adds up to the one above: sales by where/when rung up, refunds by the receiving till/day,
  cash counts by shift (shift's own expected/counted/variance; day = day the shift opened).
- Export CSV of the current level (UTF-8 BOM for Excel / Arabic).
- Tests: `tests/unit/posReports.test.ts`.
