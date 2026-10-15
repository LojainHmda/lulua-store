import { useState } from "react";
import { useAdminAuth } from "../admin/AdminAuthContext";
import { Modal } from "../admin/components/Modal";
import { logActivity } from "../admin/logActivity";
import type { RegisterSession } from "../admin/types";
import { NumberInput, type NumericValue } from "../components/ui/NumberInput";
import { useLanguage } from "../context/LanguageContext";
import { recordCashWithdrawal, RegisterSessionError } from "../firebase/registerSession";
import { formatPrice } from "../utils/currency";

// Cash taken out of the drawer mid-shift (a pay-out, a bank drop). Recorded
// against the open session so it's subtracted from the expected cash at close.
export default function CashWithdrawal({ session, open, onClose, onDone }: { session: RegisterSession; open: boolean; onClose: () => void; onDone: () => void }) {
  const { t } = useLanguage();
  const { profile } = useAdminAuth();
  const [amount, setAmount] = useState<NumericValue>(null);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close() {
    setAmount(null);
    setReason("");
    setError(null);
    onClose();
  }

  async function submit() {
    if (!profile || amount === null || amount <= 0) return;
    setSubmitting(true);
    setError(null);
    // On a POS device the signed-in identity is the till; the person is
    // whoever started the shift.
    const name = profile.posLink ? session.cashierName : profile.displayName;
    try {
      await recordCashWithdrawal(session.id, amount, reason, { uid: profile.id, name });
      await logActivity({ id: profile.id, email: profile.email, displayName: name }, "pos.cashWithdrawal", `${formatPrice(amount)}${reason.trim() ? ` · ${reason.trim()}` : ""}`);
      onDone();
      close();
    } catch (err) {
      setError(err instanceof RegisterSessionError ? err.message : t("pos.cashOut.failed"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} onClose={close} title={t("pos.cashOut.title")} width="sm">
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold text-ink">{t("pos.cashOut.amount")}</span>
          <NumberInput
            min={0}
            nullable
            autoFocus
            value={amount}
            onChange={setAmount}
            className="rounded-xl border border-line bg-paper px-4 py-3 text-base outline-none focus:border-wine"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold text-ink">{t("pos.cashOut.reason")}</span>
          <input
            value={reason}
            maxLength={200}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
            className="rounded-xl border border-line bg-paper px-4 py-3 text-base outline-none focus:border-wine"
          />
        </label>
        {error && <p className="rounded-lg bg-wine-light px-3 py-2 text-sm font-semibold text-wine">{error}</p>}
        <button
          onClick={() => void submit()}
          disabled={submitting || amount === null || amount <= 0}
          className="rounded-full bg-wine py-3 text-sm font-semibold text-on-accent hover:bg-wine-dark disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitting ? t("pos.cashOut.saving") : t("pos.cashOut.confirm")}
        </button>
      </div>
    </Modal>
  );
}
