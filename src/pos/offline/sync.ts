import type { OfflineStore, PendingSale } from "./offlineStore";

// Sending the sales a till made offline. Kept free of React and of the
// database so it can be tested on its own (tests/unit/offlineSync.test.ts).
//
// For each of this cashier's waiting sales, oldest first:
//   sent / already recorded -> removed from the device
//   still no connection     -> stop; try again when back online
//   refused by the server   -> kept on the device as an "issue" AND reported
//                              to the server (posSyncIssues) for an admin to
//                              review -- a sale that happened is never dropped.

export type SendOutcome =
  | { kind: "sent"; alreadyRecorded?: boolean; stockShortage?: { name: string; short: number }[] }
  | { kind: "offline" }
  | { kind: "issue"; code: string; message: string };

export interface SyncReport {
  sent: PendingSale[];
  issues: PendingSale[];
  stoppedOffline: boolean;
}

export async function syncPending(
  store: OfflineStore,
  cashierUid: string,
  send: (p: PendingSale) => Promise<SendOutcome>,
  reportIssue: (p: PendingSale) => Promise<boolean>
): Promise<SyncReport> {
  const report: SyncReport = { sent: [], issues: [], stoppedOffline: false };
  const mine = (await store.list()).filter((p) => p.cashierUid === cashierUid).sort((a, b) => a.createdAt - b.createdAt);
  for (const p of mine) {
    if (p.status === "issue") {
      // Already refused; only make sure the server has the report.
      if (p.issue && !p.issue.reported) {
        const ok = await reportIssue(p).catch(() => false);
        if (ok) await store.put({ ...p, issue: { ...p.issue, reported: true } });
        else {
          report.stoppedOffline = true;
          break;
        }
      }
      continue;
    }
    const out = await send(p).catch((e: unknown): SendOutcome => ({ kind: "issue", code: "unknown", message: String((e as Error)?.message ?? e) }));
    if (out.kind === "offline") {
      await store.put({ ...p, attempts: p.attempts + 1 });
      report.stoppedOffline = true;
      break;
    }
    if (out.kind === "sent") {
      await store.remove(p.id);
      report.sent.push(p);
      continue;
    }
    const flagged: PendingSale = { ...p, status: "issue", attempts: p.attempts + 1, issue: { code: out.code, message: out.message, reported: false } };
    const reported = await reportIssue(flagged).catch(() => false);
    flagged.issue!.reported = reported;
    await store.put(flagged);
    report.issues.push(flagged);
  }
  return report;
}
