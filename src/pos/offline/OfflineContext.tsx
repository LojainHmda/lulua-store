import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { doc, getDoc, serverTimestamp, setDoc, Timestamp } from "../../db/firestore";
import { useAdminAuth } from "../../admin/AdminAuthContext";
import { logActivity } from "../../admin/logActivity";
import type { RegisterSession } from "../../admin/types";
import { db } from "../../firebase/config";
import { placeOrder, PlaceOrderError, PromotionsChangedError } from "../../firebase/orderTransaction";
import { formatPrice } from "../../utils/currency";
import { idbStore, type PendingSale } from "./offlineStore";
import { syncPending, type SendOutcome } from "./sync";

// The till's connection state and its offline sales queue, shared by every
// POS screen. "Online" = the browser has a network AND the server answered
// recently; a failed request (markOffline) flips it until a check succeeds.
// While online, waiting sales are sent automatically, oldest first.

interface OfflineState {
  online: boolean;
  // Every offline sale on this device for the signed-in user.
  sales: PendingSale[];
  pendingCount: number;
  issueCount: number;
  syncing: boolean;
  markOffline: () => void;
  addPending: (p: PendingSale) => Promise<void>;
  syncNow: () => void;
  // After a shift closes: drop what the server already has (reported
  // issues) from this device. Unsent sales are never dropped.
  forgetSession: (sessionId: string) => Promise<void>;
}

const DEFAULT: OfflineState = {
  online: true,
  sales: [],
  pendingCount: 0,
  issueCount: 0,
  syncing: false,
  markOffline: () => {},
  addPending: async () => {},
  syncNow: () => {},
  forgetSession: async () => {},
};

const Ctx = createContext<OfflineState>(DEFAULT);
export const useOffline = () => useContext(Ctx);

const store = idbStore();

function issueOf(e: unknown): SendOutcome {
  const code = (e as { code?: string })?.code;
  if (code === "unavailable" || code === "aborted") return { kind: "offline" };
  if (e instanceof PromotionsChangedError) return { kind: "issue", code: "promotionsChanged", message: e.message };
  if (e instanceof PlaceOrderError) return { kind: "issue", code: "rejected", message: e.message };
  if (code === "permission-denied") return { kind: "issue", code: "denied", message: (e as Error).message };
  return { kind: "issue", code: "unknown", message: String((e as Error)?.message ?? e) };
}

export function OfflineProvider({ session, onSynced, children }: { session: RegisterSession | null; onSynced: () => void; children: ReactNode }) {
  const { profile } = useAdminAuth();
  const uid = profile?.id ?? "";
  const [browserOnline, setBrowserOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  const [serverOk, setServerOk] = useState(true);
  const [all, setAll] = useState<PendingSale[]>([]);
  const [syncing, setSyncing] = useState(false);
  const running = useRef(false);
  const [kick, setKick] = useState(0);
  const online = browserOnline && serverOk;

  const reload = useCallback(() => {
    store
      .list()
      .then(setAll)
      .catch(() => setAll([]));
  }, []);
  useEffect(reload, [reload]);

  useEffect(() => {
    const on = () => {
      setBrowserOnline(true);
      setKick((k) => k + 1);
    };
    const off = () => setBrowserOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  // While the server is unreachable, check every few seconds whether it's back.
  useEffect(() => {
    if (serverOk || !browserOnline) return;
    let stop = false;
    const check = () =>
      getDoc(doc(db, "settings", "posReturns"))
        .then(() => !stop && setServerOk(true))
        .catch(() => {});
    void check();
    const t = setInterval(check, 5000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [serverOk, browserOnline, kick]);

  const markOffline = useCallback(() => setServerOk(false), []);

  const addPending = useCallback(
    async (p: PendingSale) => {
      await store.put(p);
      reload();
    },
    [reload]
  );

  const mine = useMemo(() => all.filter((p) => p.cashierUid === uid), [all, uid]);
  const pendingCount = mine.filter((p) => p.status === "pending").length;
  const unreported = mine.filter((p) => p.status === "issue" && !p.issue?.reported).length;

  // Send what's waiting whenever we're online.
  useEffect(() => {
    if (!online || !uid || running.current || (pendingCount === 0 && unreported === 0)) return;
    running.current = true;
    setSyncing(true);
    const name = profile?.posLink ? (session?.cashierName ?? profile.displayName) : (profile?.displayName ?? "");
    void syncPending(
      store,
      uid,
      async (p) => {
        try {
          const r = await placeOrder({
            lines: p.input.lines,
            customerName: "Walk-in customer",
            customerEmail: "",
            source: "pos",
            status: "completed",
            discount: p.input.discount,
            discountPercent: p.input.discountPercent,
            expectedPromoDiscount: p.input.expectedPromoDiscount,
            paymentMethod: p.input.paymentMethod,
            cashAmount: p.input.cashAmount,
            cardAmount: p.input.cardAmount,
            registerSessionId: p.sessionId,
            orderId: p.id,
            orderNumber: p.orderNumber,
            offline: { createdAt: p.createdAt, linePrices: p.input.linePrices },
          });
          return { kind: "sent", alreadyRecorded: r.alreadyRecorded, stockShortage: r.stockShortage };
        } catch (e) {
          return issueOf(e);
        }
      },
      async (p) => {
        await setDoc(doc(db, "posSyncIssues", p.id), {
          orderNumber: p.orderNumber,
          status: "open",
          reason: p.issue?.code ?? "unknown",
          message: (p.issue?.message ?? "").slice(0, 500),
          branchId: p.branchId,
          registerId: p.registerId,
          registerName: p.registerName ?? "",
          sessionId: p.sessionId,
          cashierUid: p.cashierUid,
          cashierName: p.cashierName,
          saleCreatedAt: Timestamp.fromMillis(p.createdAt),
          total: p.total,
          itemCount: p.itemCount,
          sale: p.input,
          lines: p.receipt.lines.map((l) => ({ name: l.name, color: l.color, size: l.size, qty: l.qty, price: l.price })),
          reportedAt: serverTimestamp(),
        });
        return true;
      }
    )
      .then((r) => {
        if (r.stoppedOffline) setServerOk(false);
        for (const p of r.sent) {
          if (profile) void logActivity({ id: profile.id, email: profile.email, displayName: name }, "pos.offlineSaleSynced", `#${p.orderNumber}`, formatPrice(p.total));
        }
        if (r.sent.length > 0) onSynced();
      })
      .finally(() => {
        running.current = false;
        setSyncing(false);
        reload();
      });
  }, [online, uid, pendingCount, unreported, kick, profile, session, onSynced, reload]);

  const value = useMemo<OfflineState>(
    () => ({
      online,
      sales: mine,
      pendingCount,
      issueCount: mine.filter((p) => p.status === "issue").length,
      syncing,
      markOffline,
      addPending,
      syncNow: () => {
        setServerOk(true);
        setKick((k) => k + 1);
      },
      forgetSession: async (sessionId: string) => {
        for (const p of mine) if (p.sessionId === sessionId && p.status === "issue" && p.issue?.reported) await store.remove(p.id);
        reload();
      },
    }),
    [online, mine, pendingCount, syncing, markOffline, addPending, reload]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
