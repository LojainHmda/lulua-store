import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useLanguage } from "../../context/LanguageContext";
import { db } from "../../firebase/config";
import { listReturnsForSale, tsDate } from "../../firebase/posReturn";
import { barcodeDataUrl } from "../../hooks/useBarcodeImage";
import { posReturnToReceiptData, ReceiptPreview } from "../../receipts/ReceiptPreview";
import { formatPrice } from "../../utils/currency";
import { RETURN_REASON_LABEL_KEY } from "../returnsHelpers";
import type { AdminOrder, PosReturn } from "../types";
import { Modal } from "./Modal";
import { Badge, Card } from "./ui";

function useFmt() {
  const { lang } = useLanguage();
  return (v: unknown) => {
    const d = tsDate(v);
    return d ? d.toLocaleString(lang === "ar" ? "ar" : "en-US", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
  };
}

// One in-store return: where it came back, against which sale, every line
// (refund, back to stock or damaged), how the money went back, and its
// refund receipt for reprinting.
export function PosReturnDetailModal({ ret, onClose }: { ret: PosReturn | null; onClose: () => void }) {
  const { t, lang } = useLanguage();
  const fmt = useFmt();
  const [showReceipt, setShowReceipt] = useState(false);
  useEffect(() => setShowReceipt(false), [ret]);

  const rows: [string, React.ReactNode][] = ret
    ? [
        [t("pos.returns.returnNo"), <span key="n" className="font-mono">{ret.returnNumber}</span>],
        [t("pos.branch.time"), fmt(ret.createdAt)],
        [
          t("pos.returns.originalSale"),
          ret.orderId ? (
            <Link key="o" to={`/admin/orders/${ret.orderId}`} onClick={onClose} className="font-mono font-semibold text-wine hover:underline">
              {ret.orderNumber}
            </Link>
          ) : (
            t("pos.returns.noReceiptShort")
          ),
        ],
        ...(ret.orderId ? [[t("pos.returns.soldAt"), `${ret.saleBranchName ?? "—"} · ${ret.saleRegisterName ?? "—"} · ${fmt(ret.saleCreatedAt)}`] as [string, React.ReactNode]] : []),
        [t("pos.returns.returnedAt"), `${ret.branchName ?? "—"} · ${ret.registerName ?? "—"}`],
        [t("pos.branch.cashier"), ret.cashierName],
        [t("pos.returns.reason"), `${t(RETURN_REASON_LABEL_KEY[ret.reason])}${ret.note ? ` — ${ret.note}` : ""}`],
        [t("pos.returns.refundMethod"), t(`pos.terminal.payment.${ret.refundMethod}`)],
        [t("pos.returns.cashBack"), formatPrice(ret.cashRefund)],
        [t("pos.returns.toCard"), formatPrice(ret.cardRefund)],
      ]
    : [];

  return (
    <Modal open={!!ret} onClose={onClose} title={t("pos.returns.detailTitle")} width="lg">
      {ret && (
        <div className="flex flex-col gap-4">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            {rows.map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3 border-b border-line/60 py-1">
                <dt className="text-ink-soft">{k}</dt>
                <dd className="text-end text-ink">{v}</dd>
              </div>
            ))}
          </dl>
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-sm">
              <thead className="bg-cream-dim text-xs uppercase text-ink-faint">
                <tr>
                  <th className="px-3 py-2 text-start">{t("pos.returns.item")}</th>
                  <th className="px-3 py-2 text-end">{t("pos.returns.returnQty")}</th>
                  <th className="px-3 py-2 text-start">{t("pos.returns.condition")}</th>
                  <th className="px-3 py-2 text-end">{t("pos.returns.refund")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {ret.lines.map((l) => (
                  <tr key={`${l.productId}-${l.variantId}-${l.size}`}>
                    <td className="px-3 py-2">
                      <b className="text-ink">{l.name}</b> <span className="text-xs text-ink-faint">{l.color} · {l.size}</span>
                    </td>
                    <td className="px-3 py-2 text-end">{l.qty}</td>
                    <td className="px-3 py-2">
                      <Badge tone={l.restock ? "success" : "danger"}>{l.restock ? t("pos.returns.backToStock") : t("pos.returns.damaged")}</Badge>
                    </td>
                    <td className="px-3 py-2 text-end font-semibold">{formatPrice(l.refund)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-line font-bold">
                  <td className="px-3 py-2">{t("pos.returns.refundTotal")}</td>
                  <td className="px-3 py-2 text-end">{ret.itemCount}</td>
                  <td />
                  <td className="px-3 py-2 text-end">{formatPrice(ret.refundTotal)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          {showReceipt ? (
            <ReceiptPreview data={posReturnToReceiptData(ret, barcodeDataUrl(ret.returnNumber))} lang={lang} orderNumber={ret.returnNumber} />
          ) : (
            <button onClick={() => setShowReceipt(true)} className="self-start text-sm font-semibold text-wine hover:underline">
              {t("pos.returns.showReceipt")}
            </button>
          )}
        </div>
      )}
    </Modal>
  );
}

// Returns against one POS sale (admin order page): refunded so far and each
// return, linking to its details.
export function PosSaleReturns({ order }: { order: AdminOrder }) {
  const { t } = useLanguage();
  const fmt = useFmt();
  const [returns, setReturns] = useState<PosReturn[]>([]);
  const [open, setOpen] = useState<PosReturn | null>(null);

  useEffect(() => {
    listReturnsForSale(db, order.id)
      .then(setReturns)
      .catch(() => setReturns([]));
  }, [order.id, order.lastReturnId]);

  if (returns.length === 0) return null;
  return (
    <Card className="mb-4 p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-base font-bold text-ink">{t("pos.returns.title")}</h2>
        <span className="text-sm text-ink-soft">
          {t("pos.returns.refundedSoFar")}: <b className="text-wine">-{formatPrice(order.refundedTotal ?? 0)}</b>
          {order.refundStatus === "full" && (
            <span className="ms-2">
              <Badge tone="neutral">{t("pos.returns.fullyReturned")}</Badge>
            </span>
          )}
        </span>
      </div>
      <ul className="divide-y divide-line text-sm">
        {returns.map((r) => (
          <li key={r.id}>
            <button onClick={() => setOpen(r)} className="flex w-full items-center justify-between gap-3 py-1.5 text-start hover:bg-cream-dim/50">
              <span>
                <span className="font-mono text-xs font-semibold text-wine">{r.returnNumber}</span>
                <span className="ms-2 text-ink-soft">
                  {fmt(r.createdAt)} · {r.branchName ?? r.branchCode} · {r.cashierName} · {t("pos.branch.items")}: {r.itemCount} · {t(`pos.terminal.payment.${r.refundMethod}`)}
                </span>
              </span>
              <span className="font-semibold text-ink">-{formatPrice(r.refundTotal)}</span>
            </button>
          </li>
        ))}
      </ul>
      <PosReturnDetailModal ret={open} onClose={() => setOpen(null)} />
    </Card>
  );
}
