// Shared minimal identity shape passed into every staff-attribution write
// path (order edits/cancellation/preparation/returns/register close/etc.).
// `uid` is authoritative -- it must always be the Firebase Auth uid of the
// currently authenticated employee (from useAdminAuth().profile.id or
// useAdminSession().uid), never free-typed. `email`/`displayName` are
// point-in-time display snapshots, not a live join. Consolidates what used
// to be three near-identical local `Actor` interfaces (adminOrderEdit.ts,
// orderCancellation.ts, returnsTransaction.ts) now that a `uid` field needs
// adding to all of them consistently -- see Phase A employee-attribution
// work.
export interface Actor {
  uid: string;
  email: string;
  displayName: string;
}
