import { transaction, type Db } from "./db.ts";
import type { StripeEvent } from "./events.ts";
import type { EventHandler } from "./webhook.ts";
import { assertMinorUnits, normalizeCurrency } from "./money.ts";

/**
 * Handlers mirror Stripe objects into SQLite. Two rules hold for all of them:
 *
 *  - They are idempotent: applying the same event twice leaves the same rows (upserts keyed by
 *    Stripe ids). Event-id dedupe is a second line of defence, not the only one.
 *  - They are safe against out-of-order delivery (Stripe does not guarantee order): a row never
 *    moves backwards because an older event arrived late. See the comment on each handler.
 */
export type Outcome = { result: "applied" | "stale" | "ignored"; note?: string };

/** The event is signed and parseable but lacks something the handler needs: surfaces as a 500. */
export class EventShapeError extends Error {}

type Obj = Record<string, unknown>;
type Param = null | number | string;

const applied = (): Outcome => ({ result: "applied" });
const stale = (note: string): Outcome => ({ result: "stale", note });
const ignored = (note: string): Outcome => ({ result: "ignored", note });

// ---- reading untrusted objects -------------------------------------------------------------------

function asObj(value: unknown): Obj | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Obj) : undefined;
}
function optStr(o: Obj, key: string): string | null {
  const v = o[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}
function reqStr(o: Obj, key: string, what: string): string {
  const v = optStr(o, key);
  if (v === null) throw new EventShapeError(`${what}: missing string field "${key}"`);
  return v;
}
function optInt(o: Obj, key: string): number | null {
  const v = o[key];
  return typeof v === "number" && Number.isSafeInteger(v) ? v : null;
}
function reqMinor(o: Obj, key: string, what: string): number {
  const v = optInt(o, key);
  if (v === null || v < 0) throw new EventShapeError(`${what}: "${key}" must be a non-negative integer (minor units)`);
  assertMinorUnits(v);
  return v;
}
function reqCurrency(o: Obj, what: string): string {
  try {
    return normalizeCurrency(reqStr(o, "currency", what));
  } catch (error) {
    throw new EventShapeError(`${what}: ${(error as Error).message}`);
  }
}
/** Expandable fields arrive as an id string, an expanded object with an `id`, or null. */
function idOf(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  const o = asObj(value);
  return o ? optStr(o, "id") : null;
}

// ---- shared row helpers --------------------------------------------------------------------------

function ensureCustomer(db: Db, id: string | null, email: string | null, name: string | null, at: number): void {
  if (id === null) return;
  db.prepare(
    `INSERT INTO customers (id, email, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       email = COALESCE(excluded.email, customers.email),
       name = COALESCE(excluded.name, customers.name),
       updated_at = MAX(customers.updated_at, excluded.updated_at)`,
  ).run(id, email, name, at, at);
}

type PaymentStatus = "failed" | "succeeded" | "partially_refunded" | "refunded";
const PAYMENT_RANK: Record<PaymentStatus, number> = { failed: 1, succeeded: 2, partially_refunded: 3, refunded: 4 };

interface PaymentUpdate {
  paymentIntentId: string;
  chargeId: string | null;
  customerId: string | null;
  invoiceId: string | null;
  amount: number;
  currency: string;
  /** What this event says: failed, succeeded, or (from a charge) the refund total so far. */
  status: "failed" | "succeeded";
  amountRefunded: number;
  failureCode: string | null;
  failureMessage: string | null;
  paidAt: number | null;
}

/**
 * Payment state only moves forward: failed < succeeded < partially_refunded < refunded. A late
 * "payment failed" cannot undo a success, and a late "invoice paid" cannot undo a refund. The
 * refunded amount is a high-water mark (MAX), so an older charge snapshot cannot lower it.
 * Within the same rank the event with the higher `created` wins (ties: last delivered).
 */
function upsertPayment(db: Db, u: PaymentUpdate, event: StripeEvent): Outcome {
  const row = db.prepare("SELECT * FROM payments WHERE payment_intent_id = ?").get(u.paymentIntentId) as Obj | undefined;
  const now = event.created;
  if (!row) {
    const status = derivePaymentStatus(u.status, u.amount, u.amountRefunded);
    db.prepare(
      `INSERT INTO payments (payment_intent_id, charge_id, customer_id, invoice_id, amount, currency, status, amount_refunded,
                             failure_code, failure_message, paid_at, last_event_created, last_event_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      u.paymentIntentId, u.chargeId, u.customerId, u.invoiceId, u.amount, u.currency, status, u.amountRefunded,
      status === "failed" ? u.failureCode : null, status === "failed" ? u.failureMessage : null,
      u.paidAt, event.created, event.id, now,
    );
    return applied();
  }

  const oldStatus = row["status"] as PaymentStatus;
  const oldCreated = row["last_event_created"] as number;
  const oldRefunded = row["amount_refunded"] as number;
  const refunded = Math.max(oldRefunded, u.amountRefunded);
  const candidate = derivePaymentStatus(u.status, u.amount, refunded);
  const forward =
    PAYMENT_RANK[candidate] > PAYMENT_RANK[oldStatus] ||
    (PAYMENT_RANK[candidate] === PAYMENT_RANK[oldStatus] && event.created >= oldCreated);
  const status = forward ? candidate : oldStatus;

  // Facts that never conflict are filled in even by a late event; fields describing the state
  // (amount, currency, failure) only change when the event moves the row forward.
  const params: Param[] = [
    status,
    refunded,
    forward ? u.amount : (row["amount"] as number),
    forward ? u.currency : (row["currency"] as string),
    status === "failed" ? (forward ? u.failureCode : (row["failure_code"] as string | null)) : null,
    status === "failed" ? (forward ? u.failureMessage : (row["failure_message"] as string | null)) : null,
    (row["charge_id"] as string | null) ?? u.chargeId,
    (row["customer_id"] as string | null) ?? u.customerId,
    (row["invoice_id"] as string | null) ?? u.invoiceId,
    (row["paid_at"] as number | null) ?? u.paidAt,
    forward ? Math.max(event.created, oldCreated) : oldCreated,
    forward ? event.id : (row["last_event_id"] as string | null),
    now,
    u.paymentIntentId,
  ];
  db.prepare(
    `UPDATE payments SET status = ?, amount_refunded = ?, amount = ?, currency = ?, failure_code = ?, failure_message = ?,
       charge_id = ?, customer_id = ?, invoice_id = ?, paid_at = ?, last_event_created = ?, last_event_id = ?, updated_at = ?
     WHERE payment_intent_id = ?`,
  ).run(...params);
  return forward ? applied() : stale(`payment ${u.paymentIntentId} is already ${oldStatus}`);
}

function derivePaymentStatus(eventStatus: "failed" | "succeeded", amount: number, refunded: number): PaymentStatus {
  if (refunded > 0 && refunded >= amount) return "refunded";
  if (refunded > 0) return "partially_refunded";
  return eventStatus;
}

// ---- handlers ------------------------------------------------------------------------------------

/**
 * checkout.session.completed -> order (pending -> paid, never back), the customer, and for a
 * one-time payment the payment. For a subscription it leaves a `pending` stub (last_event_created 0)
 * so the order can point at it; every real subscription event overwrites the stub.
 */
function checkoutSessionCompleted(db: Db, event: StripeEvent): Outcome {
  const s = event.data.object;
  const what = "checkout.session";
  const id = reqStr(s, "id", what);
  const mode = reqStr(s, "mode", what);
  if (mode !== "payment" && mode !== "subscription" && mode !== "setup") throw new EventShapeError(`${what}: unknown mode ${mode}`);
  const paymentStatus = optStr(s, "payment_status");
  const orderStatus = paymentStatus === "unpaid" ? "pending" : "paid";
  const details = asObj(s["customer_details"]);
  const email = (details && optStr(details, "email")) ?? optStr(s, "customer_email");
  const name = details ? optStr(details, "name") : null;
  const customerId = idOf(s["customer"]);
  const paymentIntentId = idOf(s["payment_intent"]);
  const subscriptionId = idOf(s["subscription"]);
  const total = optInt(s, "amount_total") ?? 0;
  const currency = reqCurrency(s, what);
  const createdAt = optInt(s, "created") ?? event.created;

  ensureCustomer(db, customerId, email, name, event.created);
  db.prepare(
    `INSERT INTO orders (id, customer_id, mode, status, amount_total, currency, payment_intent_id, subscription_id,
                         client_reference_id, customer_email, last_event_created, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       status = CASE WHEN orders.status = 'paid' THEN 'paid' ELSE excluded.status END,
       customer_id = COALESCE(orders.customer_id, excluded.customer_id),
       payment_intent_id = COALESCE(orders.payment_intent_id, excluded.payment_intent_id),
       subscription_id = COALESCE(orders.subscription_id, excluded.subscription_id),
       last_event_created = MAX(orders.last_event_created, excluded.last_event_created)`,
  ).run(id, customerId, mode, orderStatus, total, currency, paymentIntentId, subscriptionId,
    optStr(s, "client_reference_id"), email, event.created, createdAt);

  if (mode === "subscription" && subscriptionId !== null) {
    db.prepare(
      `INSERT INTO subscriptions (id, customer_id, status, last_event_created, created_at) VALUES (?, ?, 'pending', 0, ?)
       ON CONFLICT (id) DO UPDATE SET customer_id = COALESCE(subscriptions.customer_id, excluded.customer_id)`,
    ).run(subscriptionId, customerId, event.created);
  }
  if (mode === "payment" && paymentIntentId !== null && orderStatus === "paid") {
    return upsertPayment(db, {
      paymentIntentId, chargeId: null, customerId, invoiceId: null, amount: total, currency,
      status: "succeeded", amountRefunded: 0, failureCode: null, failureMessage: null, paidAt: createdAt,
    }, event);
  }
  return applied();
}

/** invoice.paid -> a succeeded payment keyed by the invoice's PaymentIntent. */
function invoicePaid(db: Db, event: StripeEvent): Outcome {
  const inv = event.data.object;
  const what = "invoice";
  const id = reqStr(inv, "id", what);
  const paymentIntentId = idOf(inv["payment_intent"]);
  if (paymentIntentId === null) return ignored("invoice has no payment_intent (zero-amount invoice or an API version that dropped the field)");
  const amount = reqMinor(inv, "amount_paid", what);
  if (amount === 0) return ignored("invoice amount_paid is 0");
  const customerId = idOf(inv["customer"]);
  ensureCustomer(db, customerId, optStr(inv, "customer_email"), null, event.created);
  const transitions = asObj(inv["status_transitions"]);
  return upsertPayment(db, {
    paymentIntentId, chargeId: idOf(inv["charge"]), customerId, invoiceId: id, amount, currency: reqCurrency(inv, what),
    status: "succeeded", amountRefunded: 0, failureCode: null, failureMessage: null,
    paidAt: (transitions && optInt(transitions, "paid_at")) ?? optInt(inv, "created"),
  }, event);
}

/** invoice.payment_failed -> a failed payment row; cannot override a success (rank rule). */
function invoicePaymentFailed(db: Db, event: StripeEvent): Outcome {
  const inv = event.data.object;
  const what = "invoice";
  const id = reqStr(inv, "id", what);
  const paymentIntentId = idOf(inv["payment_intent"]);
  if (paymentIntentId === null) return ignored("invoice has no payment_intent");
  const customerId = idOf(inv["customer"]);
  ensureCustomer(db, customerId, optStr(inv, "customer_email"), null, event.created);
  const attempt = optInt(inv, "attempt_count");
  return upsertPayment(db, {
    paymentIntentId, chargeId: null, customerId, invoiceId: id, amount: reqMinor(inv, "amount_due", what),
    currency: reqCurrency(inv, what), status: "failed", amountRefunded: 0, failureCode: "invoice_payment_failed",
    failureMessage: attempt === null ? "invoice payment failed" : `invoice payment failed (attempt ${attempt})`,
    paidAt: null,
  }, event);
}

/** payment_intent.payment_failed -> a failed payment row carrying Stripe's decline code and message. */
function paymentIntentFailed(db: Db, event: StripeEvent): Outcome {
  const pi = event.data.object;
  const what = "payment_intent";
  const id = reqStr(pi, "id", what);
  const customerId = idOf(pi["customer"]);
  ensureCustomer(db, customerId, null, null, event.created);
  const err = asObj(pi["last_payment_error"]);
  return upsertPayment(db, {
    paymentIntentId: id, chargeId: null, customerId, invoiceId: idOf(pi["invoice"]), amount: reqMinor(pi, "amount", what),
    currency: reqCurrency(pi, what), status: "failed", amountRefunded: 0,
    failureCode: err ? (optStr(err, "decline_code") ?? optStr(err, "code")) : null,
    failureMessage: err ? optStr(err, "message") : null,
    paidAt: null,
  }, event);
}

/**
 * charge.refunded -> the refund total on the payment (high-water mark), plus one `refunds` row per
 * refund when the charge carries its `refunds.data` list. Newer API versions do not include that
 * list unless it is expanded; then only the total is recorded.
 */
function chargeRefunded(db: Db, event: StripeEvent): Outcome {
  const ch = event.data.object;
  const what = "charge";
  const chargeId = reqStr(ch, "id", what);
  const paymentIntentId = idOf(ch["payment_intent"]);
  if (paymentIntentId === null) return ignored("charge has no payment_intent (legacy Charges API)");
  const currency = reqCurrency(ch, what);
  const customerId = idOf(ch["customer"]);
  ensureCustomer(db, customerId, null, null, event.created);

  const list = asObj(ch["refunds"]);
  const items = list && Array.isArray(list["data"]) ? (list["data"] as unknown[]) : [];
  for (const raw of items) {
    const r = asObj(raw);
    if (!r) continue;
    const refundId = reqStr(r, "id", "refund");
    // A settled refund (succeeded/failed/canceled) is final; only a still-open one may change.
    db.prepare(
      `INSERT INTO refunds (id, charge_id, payment_intent_id, amount, currency, status, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET status = excluded.status, amount = excluded.amount, reason = excluded.reason
       WHERE refunds.status IS NULL OR refunds.status IN ('pending', 'requires_action')`,
    ).run(refundId, chargeId, paymentIntentId, reqMinor(r, "amount", "refund"), reqCurrency(r, "refund"),
      optStr(r, "status"), optStr(r, "reason"), optInt(r, "created") ?? event.created);
  }

  return upsertPayment(db, {
    paymentIntentId, chargeId, customerId, invoiceId: idOf(ch["invoice"]), amount: reqMinor(ch, "amount", what), currency,
    status: "succeeded", amountRefunded: reqMinor(ch, "amount_refunded", what), failureCode: null, failureMessage: null,
    paidAt: optInt(ch, "created"),
  }, event);
}

/**
 * customer.subscription.updated / .deleted.
 *   - `canceled` is terminal: Stripe never revives a subscription id, so any later event for a
 *     canceled row (a stale "active" update arriving after the deletion) is ignored.
 *   - `deleted` always applies (it is the last event of a subscription's life), even if an
 *     update with a later `created` was delivered first.
 *   - Any other update applies only if its `created` is not older than the newest event applied.
 *   - A `pending` stub from checkout has last_event_created 0, so any real event replaces it.
 */
function subscriptionChanged(db: Db, event: StripeEvent): Outcome {
  const sub = event.data.object;
  const what = "subscription";
  const id = reqStr(sub, "id", what);
  const deleted = event.type === "customer.subscription.deleted";
  const status = deleted ? "canceled" : reqStr(sub, "status", what);
  const customerId = idOf(sub["customer"]);
  const items = asObj(sub["items"]);
  const first = items && Array.isArray(items["data"]) ? asObj((items["data"] as unknown[])[0]) : undefined;
  const priceId = first ? idOf(first["price"]) : null;
  const periodEnd = optInt(sub, "current_period_end") ?? (first ? optInt(first, "current_period_end") : null);
  const cancelAtPeriodEnd = sub["cancel_at_period_end"] === true ? 1 : 0;
  const canceledAt = optInt(sub, "canceled_at") ?? (status === "canceled" ? event.created : null);

  ensureCustomer(db, customerId, null, null, event.created);
  const row = db.prepare("SELECT status, last_event_created FROM subscriptions WHERE id = ?").get(id) as
    | { status: string; last_event_created: number }
    | undefined;

  if (!row) {
    db.prepare(
      `INSERT INTO subscriptions (id, customer_id, status, price_id, current_period_end, cancel_at_period_end, canceled_at,
                                  last_event_created, last_event_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, customerId, status, priceId, periodEnd, cancelAtPeriodEnd, canceledAt, event.created, event.id, event.created);
    return applied();
  }
  if (row.status === "canceled") return stale(`subscription ${id} is already canceled`);
  if (!deleted && event.created < row.last_event_created) {
    return stale(`event ${event.id} is older than the last applied event for ${id}`);
  }

  db.prepare(
    `UPDATE subscriptions SET status = ?, customer_id = COALESCE(?, customer_id), price_id = COALESCE(?, price_id),
       current_period_end = COALESCE(?, current_period_end), cancel_at_period_end = ?, canceled_at = ?,
       last_event_created = MAX(last_event_created, ?), last_event_id = ? WHERE id = ?`,
  ).run(status, customerId, priceId, periodEnd, cancelAtPeriodEnd, canceledAt, event.created, event.id, id);
  return applied();
}

const HANDLERS: ReadonlyMap<string, (db: Db, event: StripeEvent) => Outcome> = new Map([
  ["checkout.session.completed", checkoutSessionCompleted],
  ["invoice.paid", invoicePaid],
  ["invoice.payment_failed", invoicePaymentFailed],
  ["customer.subscription.updated", subscriptionChanged],
  ["customer.subscription.deleted", subscriptionChanged],
  ["charge.refunded", chargeRefunded],
  ["payment_intent.payment_failed", paymentIntentFailed],
]);

export const HANDLED_EVENT_TYPES: readonly string[] = [...HANDLERS.keys()];

/** Applies one event in a single transaction (a throw rolls back every write of that event). */
export function applyEvent(db: Db, event: StripeEvent): Outcome {
  const handler = HANDLERS.get(event.type);
  if (!handler) return ignored(`no handler for ${event.type}`);
  return transaction(db, () => handler(db, event));
}

/** An `EventHandler` for `handleStripeWebhook`. Event types without a handler are acknowledged. */
export function createEventHandler(db: Db, options: { onOutcome?: (event: StripeEvent, outcome: Outcome) => void } = {}): EventHandler {
  return (event) => {
    const outcome = applyEvent(db, event);
    options.onOutcome?.(event, outcome);
  };
}
