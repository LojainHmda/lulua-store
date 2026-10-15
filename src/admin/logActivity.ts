import { activityLogApi } from "../firebase/collections";

// Accepts either an `AdminUser` profile (the overwhelming majority of call
// sites already pass `profile`/`currentProfile` straight from
// useAdminAuth(), which has `.id` = the real Firebase Auth uid) or an
// `Actor`-shaped object (`.uid`, used by session-derived callers like
// useAdminSession() and the order/return/register transaction functions).
// `actorUid` is the authoritative field going forward -- it is ALWAYS
// derived from one of these two, never from free text, so an employee can
// never make an activity-log entry claim to be someone else by editing a
// request payload (see firestore.rules' activityLogs/{id} create rule,
// which requires actorUid == request.auth.uid).
export async function logActivity(
  actor: { id?: string; uid?: string; email: string; displayName: string },
  action: string,
  target: string,
  details?: string
): Promise<void> {
  try {
    await activityLogApi.create({
      actorUid: actor.uid ?? actor.id,
      actorEmail: actor.email,
      actorName: actor.displayName || actor.email,
      action,
      target,
      details,
    });
  } catch {
    // Audit logging must never block the primary action.
  }
}
