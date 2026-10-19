import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAdminAuth } from "../admin/AdminAuthContext";
import { logActivity } from "../admin/logActivity";
import type { RegisterSession } from "../admin/types";
import { registerSessionsApi } from "../firebase/collections";
import { db } from "../firebase/config";
import { discardHeldSale, subscribeHeldSales } from "../firebase/heldSales";
import type { HeldSale } from "../admin/types";
import { closeRegister, RegisterSessionError, sessionExpectedCash } from "../firebase/registerSession";
import { useLanguage } from "../context/LanguageContext";
import { formatPrice } from "../utils/currency";
import { NumberInput, type NumericValue } from "../components/ui/NumberInput";
import { tillUrl } from "./posPaths";
import { useOffline } from "./offline/OfflineContext";

export default function CloseRegister({ session: initial, onClosed }: { session: RegisterSession; onClosed: () => void }) {
  const navigate = useNavigate();
  const { t } = useLanguage();
  const { profile } = useAdminAuth();
  // Live copy of the session: the totals shown must include every sale and
  // withdrawal up to the moment of closing, not just what this screen was
  // handed when it opened.
  const [session, setSession] = useState<RegisterSession>(initial);
  const [countedCash, setCountedCash] = useState<NumericValue>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);
  // A shift can't close while it's offline or has offline sales not sent yet:
  // the cash count would not match what the server knows.
  const { online, sales: offlineSales, forgetSession } = useOffline();
  const waiting = offlineSales.filter((p) => p.sessionId === initial.id && p.status === "pending").length;
  // Sales this shift put on hold and nobody resumed. They stay at the branch
  // (any till can resume them for 24h) unless the cashier discards them here.
  const [held, setHeld] = useState<HeldSale[]>([]);
  const [discarding, setDiscarding] = useState(false);
  useEffect(
    () => (initial.branchId ? subscribeHeldSales(db, initial.branchId, (list) => setHeld(list.filter((h) => h.sessionId === initial.id))) : undefined),
    [initial.branchId, initial.id]
  );
  async function discardAllHeld() {
    if (!profile) return;
    setDiscarding(true);
    const name = profile.posLink ? session.cashierName : profile.displayName;
    for (const h of held) {
      try {
        await discardHeldSale(db, h.id, { uid: profile.id, name });
        void logActivity({ id: profile.id, email: profile.email, displayName: name }, "pos.heldSaleDiscarded", h.ref, `${h.itemCount} · ${formatPrice(h.subtotal)}`);
      } catch {
        // Already resumed/discarded by another till: nothing to do.
      }
    }
    setDiscarding(false);
  }

  useEffect(() => {
    registerSessionsApi
      .get(initial.id)
      .then((s) => s && setSession(s))
      .catch(() => {});
  }, [initial.id]);

  const cashOut = session.cashOutTotal ?? 0;
  const expectedCash = sessionExpectedCash(session);
  const counted = countedCash ?? 0;
  const variance = Math.round((counted - expectedCash) * 100) / 100;

  async function handleClose() {
    if (!profile) return;
    setSubmitting(true);
    setError(null);
    try {
      // The employee actually performing the close -- not necessarily the
      // same person who opened the session (see registerSession.ts's own
      // comment); the opener's identity (cashierId/cashierName) is never
      // touched here.
      await closeRegister(session.id, counted, { uid: profile.id, email: profile.email, displayName: profile.posLink ? session.cashierName : profile.displayName });
      // Phase A section 14: supplemental activity-log entry -- the
      // session's own closedByUid/Email/Name (written above) remain the
      // source of truth.
      await logActivity(profile, "pos.registerClosed", session.cashierName);
      // Nothing of this shift needs to stay on the device any more.
      await forgetSession(session.id);
      try {
        window.sessionStorage.removeItem(`lulua-pos-cart:${session.id}`);
      } catch {
        // Storage unavailable: nothing was kept there either.
      }
      setClosed(true);
    } catch (err) {
      setError(err instanceof RegisterSessionError ? err.message : t("admin.posSales.closeFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  if (closed) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <h1 className="font-display text-2xl font-bold text-ink">{t("pos.closeRegister.closed")}</h1>
        <p className="text-sm text-ink-soft">{t("pos.closeRegister.closedBody")}</p>
        <button
          onClick={() => {
            onClosed();
            navigate("/pos", { replace: true });
          }}
          className="mt-2 rounded-full bg-wine px-8 py-3.5 text-base font-semibold text-on-accent hover:bg-wine-dark"
        >
          {t("admin.team.done")}
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full max-w-md flex-col justify-center gap-5 p-8">
      <div>
        <h1 className="font-display text-2xl font-bold text-ink">{t("pos.layout.closeRegister")}</h1>
        <p className="mt-1 text-sm text-ink-soft">
          {session.branchName && (
            <>
              {session.branchName} · {session.registerName} ·{" "}
            </>
          )}
          {session.cashierName}
        </p>
      </div>

      <div className="rounded-2xl bg-paper p-5 shadow-soft">
        <dl className="flex flex-col gap-2 text-sm">
          <div className="flex justify-between text-ink-soft">
            <dt>{t("pos.openRegister.startingCash")}</dt>
            <dd>{formatPrice(session.startingCash)}</dd>
          </div>
          <div className="flex justify-between text-ink-soft">
            <dt>{t("pos.closeRegister.cashSales")}</dt>
            <dd>+{formatPrice(session.cashTotal)}</dd>
          </div>
          <div className="flex justify-between text-ink-soft">
            <dt>{t("pos.cashOut.withdrawals")}</dt>
            <dd>-{formatPrice(cashOut)}</dd>
          </div>
          <div className="flex justify-between text-ink-soft">
            <dt>{t("pos.returns.cashRefunds")}</dt>
            <dd>-{formatPrice(session.cashRefundTotal ?? 0)}</dd>
          </div>
          <div className="flex justify-between border-t border-line pt-2 font-semibold text-ink">
            <dt>{t("pos.closeRegister.expectedCash")}</dt>
            <dd>{formatPrice(expectedCash)}</dd>
          </div>
          <div className="flex justify-between text-ink-soft">
            <dt>{t("pos.closeRegister.cardSales")}</dt>
            <dd>{formatPrice(session.cardTotal)}</dd>
          </div>
          <div className="flex justify-between text-ink-soft">
            <dt>{t("pos.returns.cardRefunds")}</dt>
            <dd>-{formatPrice(session.cardRefundTotal ?? 0)}</dd>
          </div>
          <div className="flex justify-between text-ink-soft">
            <dt>{t("pos.closeRegister.salesCount")}</dt>
            <dd>{session.salesCount}</dd>
          </div>
          {(session.refundCount ?? 0) > 0 && (
            <div className="flex justify-between text-ink-soft">
              <dt>{t("pos.returns.returnsCount")}</dt>
              <dd>{session.refundCount}</dd>
            </div>
          )}
        </dl>
      </div>

      {held.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-wine/40 bg-wine-light px-3 py-2 text-sm text-wine-dark">
          <span>
            {t("pos.hold.closeNotice").replace("{count}", String(held.length))} <span className="font-mono text-xs">{held.map((h) => h.ref).join(", ")}</span>
          </span>
          <button
            disabled={discarding}
            onClick={() => void discardAllHeld()}
            className="rounded-full border border-wine/50 px-3 py-1 text-xs font-semibold hover:bg-paper disabled:opacity-40"
          >
            {t("pos.hold.discardAll")}
          </button>
        </div>
      )}

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-semibold text-ink">{t("pos.closeRegister.countedCash")}</span>
        <NumberInput
          min={0}
          nullable
          autoFocus
          value={countedCash}
          onChange={setCountedCash}
          className="rounded-xl border border-line bg-paper px-4 py-3 text-base outline-none focus:border-wine"
        />
      </label>

      {countedCash !== null && (
        <div className={`flex justify-between text-sm font-semibold ${variance === 0 ? "text-ink-soft" : variance > 0 ? "text-olive" : "text-wine"}`}>
          <span>{t("pos.closeRegister.difference")}</span>
          <span>
            {variance === 0 ? t("pos.closeRegister.matchesExactly") : variance > 0 ? `+${formatPrice(variance)} ${t("pos.closeRegister.over")}` : `-${formatPrice(Math.abs(variance))} ${t("pos.closeRegister.short")}`}
          </span>
        </div>
      )}

      {(!online || waiting > 0) && (
        <p className="rounded-lg bg-wine-light px-3 py-2 text-sm font-semibold text-wine">
          {!online ? t("pos.offline.closeOffline") : t("pos.offline.closeWaiting").replace("{n}", String(waiting))}
        </p>
      )}
      {error && <p className="rounded-lg bg-wine-light px-3 py-2 text-sm font-semibold text-wine">{error}</p>}

      <div className="flex gap-2">
        <button onClick={() => navigate(tillUrl(session))} className="flex-1 rounded-full border border-line py-3 text-sm font-semibold text-ink hover:bg-cream-dim">
          {t("pos.closeRegister.backToSale")}
        </button>
        <button
          onClick={() => void handleClose()}
          disabled={submitting || countedCash === null || !online || waiting > 0}
          className="flex-1 rounded-full bg-wine py-3 text-sm font-semibold text-on-accent hover:bg-wine-dark disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitting ? t("pos.closeRegister.closing") : t("pos.layout.closeRegister")}
        </button>
      </div>
    </div>
  );
}
