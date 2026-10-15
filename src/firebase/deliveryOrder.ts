import { doc, runTransaction, serverTimestamp } from "firebase/firestore";
import type { Actor } from "../admin/actor";
import { buildCreateOrderPayload, type CreateOrderParams, type MissingDeliveryOrderField } from "../admin/deliveryOrderMapping";
import { logActivity } from "../admin/logActivity";
import type { AdminOrder } from "../admin/types";
import { db } from "./config";
import type { DeliveryProxyConfig } from "./deliveryOrderConfig";

export class DeliveryOrderError extends Error {}

export class DeliveryOrderAlreadySentError extends DeliveryOrderError {}

export class MissingDeliveryOrderDataError extends DeliveryOrderError {
  missing: MissingDeliveryOrderField[];
  constructor(missing: MissingDeliveryOrderField[]) {
    super(`Cannot send this order to the delivery company -- missing: ${missing.join(", ")}`);
    this.missing = missing;
  }
}

export class DeliveryOrderRequestError extends DeliveryOrderError {
  httpStatus?: number;
  constructor(message: string, httpStatus?: number) {
    super(message);
    this.httpStatus = httpStatus;
  }
}

export interface DeliveryOrderResult {
  unitedOrderId?: string;
  sequence?: string;
}

// Sends this order's Create Order request to the delivery company (Olivery,
// serving client "UnitedExp"), via the dedicated Cloud Run proxy (see
// deliveryOrderConfig.ts for exactly why a proxy exists -- direct
// browser-to-United calls are unconditionally CORS-blocked), and records
// that it was sent. `idToken` is the CALLER'S OWN fresh Firebase ID token
// (get it via `firebaseUser.getIdToken()` right before calling this -- see
// OrderDetail.tsx) -- the proxy verifies it server-side and checks the
// caller against `admins/{uid}` before doing anything, so this is real
// caller authentication, not a static shared value. See
// deliveryOrderMapping.ts for exactly which request
// fields are confirmed vs. best-effort vs. missing. The United response
// shape and several field semantics (cost/paid/customer_area/order_type_id)
// were CONFIRMED LIVE 2026-09-30 against the real United test account --
// see deliveryOrderMapping.ts's own module comment and
// migration/united-integration-2026-09-30/ for the raw, credential-redacted
// request/response artifacts this was verified against. Still open: two of
// Sisely's 14 delivery zones' United-area mapping is medium- rather than
// high-confidence (see DELIVERY_ZONE_TO_UNITED_AREA).
//
// DUPLICATE PREVENTION -- a two-phase claim, not one atomic operation:
// Firestore transactions cannot make network calls, so "check nothing was
// sent yet, call the API, record the result" can never be a single atomic
// step. Phase 1 (the first transaction below) claims `deliverySendingAt`
// after re-reading the order fresh and confirming it isn't already sent or
// already mid-send -- this is what actually stops a double-click or a
// second concurrent trigger, since only one transaction attempt can win
// that claim; every other simultaneous caller fails here, before any
// network call is made. Phase 2 (after that transaction commits) makes the
// real HTTP request; on failure the claim is released (`deliverySendingAt`
// cleared) so a genuine retry stays possible; on success,
// `deliverySentAt`/`deliverySentBy*`/`deliveryReferenceId`/
// `deliveryUnitedOrderId`/`deliverySequence` are written, which is the
// durable, permanent guard the calling UI checks afterward to hide/disable
// the send action entirely.
export async function createDeliveryOrder(orderId: string, proxyConfig: DeliveryProxyConfig, idToken: string, actor: Actor): Promise<DeliveryOrderResult> {
  const orderRef = doc(db, "orders", orderId);
  let orderNumber = "";
  let payload: CreateOrderParams | null = null;

  await runTransaction(db, async (tx) => {
    // Reset on every attempt, including retries -- Firestore replays this
    // whole callback from scratch on a write-conflict retry (same reasoning
    // as orderCancellation.ts/adminOrderEdit.ts), and both of these are read
    // from OUTSIDE the callback after commit.
    orderNumber = "";
    payload = null;

    const snap = await tx.get(orderRef);
    if (!snap.exists()) throw new DeliveryOrderError("Order not found.");
    const order = { id: snap.id, ...snap.data() } as AdminOrder;
    orderNumber = order.orderNumber;

    // The only guard that matters for idempotency, re-checked against a
    // FRESH read inside this transaction -- exactly mirrors
    // cancelOrderAndRestoreStock()'s "check the live status, not whatever
    // the UI had cached" pattern.
    if (order.deliverySentAt) {
      throw new DeliveryOrderAlreadySentError(`Order #${order.orderNumber} was already sent to the delivery company.`);
    }
    if (order.deliverySendingAt) {
      throw new DeliveryOrderAlreadySentError(`Order #${order.orderNumber} is already being sent to the delivery company (another attempt is in progress).`);
    }

    const built = buildCreateOrderPayload(order);
    if (!built.payload) throw new MissingDeliveryOrderDataError(built.missing);
    payload = built.payload;

    tx.update(orderRef, { deliverySendingAt: serverTimestamp() });
  });

  try {
    // Sent through the dedicated Cloud Run proxy, not directly to United --
    // see deliveryOrderConfig.ts for why. This is a real backend with full
    // control over its own HTTP handling, so this is a normal
    // `application/json` request with a real OPTIONS preflight the proxy
    // correctly answers -- no CORS workaround needed (unlike the Apps
    // Script PoC this replaced).
    const response = await fetch(`${proxyConfig.proxyUrl}/api/united/proxy`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ action: "create_order", params: payload }),
    });

    const rawText = await response.text();
    // Never log the REQUEST (it carries the caller's bearer token) -- only a
    // bounded preview of the RESPONSE, which never contains any credential
    // (see services/united-proxy/index.js -- it never echoes `creds`).
    const rawResponsePreview = rawText.slice(0, 2000);

    let parsedResponse: unknown;
    try {
      parsedResponse = JSON.parse(rawText);
    } catch {
      parsedResponse = undefined;
    }

    // The proxy's own wrapper shape (Code.gs's json_() responses), CONFIRMED
    // LIVE 2026-09-30 via the get_areas round-trip:
    //   { ok: boolean, unitedHttpStatus?: number, unitedResponse?: <raw
    //     United JSON-RPC response>, error?: string }
    // `ok: false` with no `unitedResponse` means the PROXY itself rejected
    // the request (invalid/expired ID token, caller not an active admin,
    // malformed request, proxy misconfigured, etc.) -- distinct from United
    // rejecting the order itself, and reported as such so the two failure
    // modes are never confused with each other.
    const proxyObj = parsedResponse && typeof parsedResponse === "object" ? (parsedResponse as Record<string, unknown>) : undefined;
    const unitedResponse = proxyObj?.unitedResponse && typeof proxyObj.unitedResponse === "object" ? (proxyObj.unitedResponse as Record<string, unknown>) : undefined;

    if (!proxyObj || (proxyObj.ok !== true && !unitedResponse)) {
      const proxyError = typeof proxyObj?.error === "string" ? proxyObj.error : undefined;
      throw new DeliveryOrderRequestError(proxyError ?? `Delivery proxy request failed (HTTP ${response.status}).`, response.status);
    }

    // United's own response shapes, unchanged from the pre-proxy design --
    // CONFIRMED LIVE (2026-09-30, against the real United test account --
    // see migration/united-integration-2026-09-30/ for the raw,
    // credential-redacted artifacts):
    //   success: { result: { code: 200, success: true, message: "Success Add",
    //              id: <number>, Sequence: "UE...", Reference: "<echo>",
    //              "Delivery cost": <number> } }
    //   failure: { result: { code: <not 200>, fail: true, message: "..." } }
    // A top-level JSON-RPC `error` key (never actually observed from this
    // provider, but valid per the JSON-RPC 2.0 spec this request uses) is
    // still checked defensively first.
    const rpcError = unitedResponse && "error" in unitedResponse ? (unitedResponse.error as { message?: string; code?: unknown } | undefined) : undefined;
    const result = unitedResponse?.result && typeof unitedResponse.result === "object" ? (unitedResponse.result as Record<string, unknown>) : undefined;
    const resultFail = result?.fail === true || (result?.success !== true && typeof result?.code === "number" && result.code !== 200);
    const resultMessage = typeof result?.message === "string" ? result.message : undefined;

    if (rpcError || resultFail || proxyObj.unitedHttpStatus !== 200) {
      const message = rpcError?.message ? String(rpcError.message) : resultMessage ?? `Delivery company request failed (HTTP ${proxyObj.unitedHttpStatus}).`;
      throw new DeliveryOrderRequestError(message, typeof proxyObj.unitedHttpStatus === "number" ? proxyObj.unitedHttpStatus : undefined);
    }

    // `id` is United's own internal numeric order id; `Sequence`
    // (capitalized in their response) is the separate tracking/label
    // number -- kept as two distinct fields on purpose, never collapsed
    // into one (see AdminOrder's own field comments in types.ts).
    const unitedOrderId = result?.id !== undefined && result.id !== null ? String(result.id) : undefined;
    const sequence = typeof result?.Sequence === "string" ? result.Sequence : undefined;

    await runTransaction(db, async (tx) => {
      tx.update(orderRef, {
        deliverySendingAt: null,
        deliverySentAt: serverTimestamp(),
        deliverySentByUid: actor.uid,
        deliverySentByEmail: actor.email,
        deliverySentByName: actor.displayName || actor.email,
        deliveryReferenceId: payload!.reference_id,
        deliveryUnitedOrderId: unitedOrderId,
        deliverySequence: sequence,
        updatedAt: serverTimestamp(),
      });
    });

    await logActivity(actor, "order.sentToDelivery", `#${orderNumber}`, `response: ${rawResponsePreview}`);

    return { unitedOrderId, sequence };
  } catch (err) {
    // Release the claim so a genuine retry (e.g. after a transient network
    // error) isn't permanently blocked by this failed attempt. Best-effort:
    // if even clearing the claim fails, the original error is still what
    // the caller needs to see -- a stuck claim is a recoverable, manually-
    // fixable state (an owner/admin could clear it directly), not a silent
    // data-loss risk.
    await runTransaction(db, async (tx) => {
      tx.update(orderRef, { deliverySendingAt: null });
    }).catch(() => {});
    throw err;
  }
}
