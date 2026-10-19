// Stable action codes passed as logActivity()'s `action` argument, instead
// of a pre-formatted English sentence — the rendering layer (ActivityLog.tsx,
// Dashboard.tsx) looks each one up via t(ACTIVITY_ACTION_LABEL_KEY[code])
// so the same stored record displays correctly in whichever language the
// viewer currently has active, rather than being frozen in whatever
// language was active when the action happened.
//
// activityLogs/{id} is an append-only audit trail (see firestore.rules —
// nobody, including owners, may update or delete an entry), so entries
// written before this system existed still hold a raw English sentence
// directly in `action`. activityActionLabel() below falls back to
// displaying that raw string verbatim when the code isn't recognized,
// which is exactly what happens for every pre-existing entry — no data
// migration needed or possible.
export const ACTIVITY_ACTION_LABEL_KEY: Record<string, string> = {
  "product.created": "admin.activityLog.actions.productCreated",
  "product.updated": "admin.activityLog.actions.productUpdated",
  "product.duplicated": "admin.activityLog.actions.productDuplicated",
  "product.archived": "admin.activityLog.actions.productArchived",
  "product.restored": "admin.activityLog.actions.productRestored",
  "product.deleted": "admin.activityLog.actions.productDeleted",
  "category.created": "admin.activityLog.actions.categoryCreated",
  "category.updated": "admin.activityLog.actions.categoryUpdated",
  "category.deleted": "admin.activityLog.actions.categoryDeleted",
  "inventory.stockUpdated": "admin.activityLog.actions.stockUpdated",
  "stock.received": "admin.activityLog.actions.stockReceived",
  "order.created": "admin.activityLog.actions.orderCreated",
  "order.statusUpdated": "admin.activityLog.actions.orderStatusUpdated",
  "order.notesUpdated": "admin.activityLog.actions.orderNotesUpdated",
  "order.itemsEdited": "admin.activityLog.actions.orderItemsEdited",
  "order.cancelled": "admin.activityLog.actions.orderCancelled",
  "order.bulkStatusUpdated": "admin.activityLog.actions.orderBulkStatusUpdated",
  "discount.created": "admin.activityLog.actions.discountCreated",
  "discount.updated": "admin.activityLog.actions.discountUpdated",
  "discount.deleted": "admin.activityLog.actions.discountDeleted",
  "customer.added": "admin.activityLog.actions.customerAdded",
  "customer.updated": "admin.activityLog.actions.customerUpdated",
  "customer.deleted": "admin.activityLog.actions.customerDeleted",
  "team.invited": "admin.activityLog.actions.teamInvited",
  "team.roleChanged": "admin.activityLog.actions.teamRoleChanged",
  "team.deactivated": "admin.activityLog.actions.teamDeactivated",
  "team.reactivated": "admin.activityLog.actions.teamReactivated",
  "team.removed": "admin.activityLog.actions.teamRemoved",
  "review.approved": "admin.activityLog.actions.reviewApproved",
  "review.pending": "admin.activityLog.actions.reviewPending",
  "review.rejected": "admin.activityLog.actions.reviewRejected",
  "review.deleted": "admin.activityLog.actions.reviewDeleted",
  "homepage.updated": "admin.activityLog.actions.homepageUpdated",
  "backup.exported": "admin.activityLog.actions.backupExported",
  "backup.restored": "admin.activityLog.actions.backupRestored",
  "settings.generalUpdated": "admin.activityLog.actions.settingsGeneralUpdated",
  "settings.appearanceUpdated": "admin.activityLog.actions.settingsAppearanceUpdated",
  "settings.colorThemeChanged": "admin.activityLog.actions.settingsColorThemeChanged",
  "settings.languageUpdated": "admin.activityLog.actions.settingsLanguageUpdated",
  "settings.seoUpdated": "admin.activityLog.actions.settingsSeoUpdated",
  "settings.contactUpdated": "admin.activityLog.actions.settingsContactUpdated",
  "settings.shippingPaymentUpdated": "admin.activityLog.actions.settingsShippingPaymentUpdated",
  "settings.searchUpdated": "admin.activityLog.actions.settingsSearchUpdated",
  "settings.exchangePolicyUpdated": "admin.activityLog.actions.settingsExchangePolicyUpdated",
  "settings.posReturnsUpdated": "admin.activityLog.actions.settingsPosReturnsUpdated",
  "pos.returnCompleted": "admin.activityLog.actions.posReturnCompleted",
  "return.logged": "admin.activityLog.actions.returnLogged",
  "return.resolvedGood": "admin.activityLog.actions.returnResolvedGood",
  "return.resolvedDamaged": "admin.activityLog.actions.returnResolvedDamaged",
  "return.needsRepair": "admin.activityLog.actions.returnNeedsRepair",
  "deliveryZone.created": "admin.activityLog.actions.deliveryZoneCreated",
  // No "deliveryZone.deleted" -- deletion isn't a valid action any more; a
  // zone is managed through activate/deactivate only (see DeliveryZones.tsx
  // and firestore.rules' deliveryZones/{id} match block, which has no
  // delete rule at all).
  "deliveryZone.updated": "admin.activityLog.actions.deliveryZoneUpdated",
  // Phase A: supplemental activity-log entries for POS sales and register
  // open/close -- the order/registerSessions documents' own direct actor
  // fields (cashierUid/Email/Name, closedByUid/Email/Name) remain the
  // source of truth; these are only for the unified activity feed.
  "pos.saleCompleted": "admin.activityLog.actions.posSaleCompleted",
  "pos.registerOpened": "admin.activityLog.actions.posRegisterOpened",
  "pos.registerClosed": "admin.activityLog.actions.posRegisterClosed",
  "pos.cashWithdrawal": "admin.activityLog.actions.posCashWithdrawal",
  "pos.cartCleared": "admin.activityLog.actions.posCartCleared",
  "pos.saleHeld": "admin.activityLog.actions.posSaleHeld",
  "pos.offlineSaleSynced": "admin.activityLog.actions.posOfflineSaleSynced",
  "pos.offlineIssueResolved": "admin.activityLog.actions.posOfflineIssueResolved",
  "branch.dayClosed": "admin.activityLog.actions.branchDayClosed",
  "pos.saleResumed": "admin.activityLog.actions.posSaleResumed",
  "pos.heldSaleDiscarded": "admin.activityLog.actions.posHeldSaleDiscarded",
  "pos.discountApplied": "admin.activityLog.actions.posDiscountApplied",
  "promotion.created": "admin.activityLog.actions.promotionCreated",
  "promotion.updated": "admin.activityLog.actions.promotionUpdated",
  "promotion.activated": "admin.activityLog.actions.promotionActivated",
  "promotion.deactivated": "admin.activityLog.actions.promotionDeactivated",
  "promotion.deleted": "admin.activityLog.actions.promotionDeleted",
  "settings.posDiscountsUpdated": "admin.activityLog.actions.settingsPosDiscountsUpdated",
};

export function activityActionLabel(t: (key: string) => string, action: string): string {
  const key = ACTIVITY_ACTION_LABEL_KEY[action];
  return key ? t(key) : action;
}
