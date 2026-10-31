import { DEMO_WEBHOOK_SECRET } from "../src/replay.ts";
import { signStripePayload } from "../src/verify.ts";

/**
 * Fixture generator: builds Stripe-shaped event payloads (fictional data) and signs them with the
 * documented scheme. Shapes follow the public docs for the pre-2025 API versions; they were not
 * captured from Stripe.
 */
export const TEST_WEBHOOK_SECRET = DEMO_WEBHOOK_SECRET;
/** 2026-01-01T00:00:00Z */
export const T0 = 1_767_225_600;

type Obj = Record<string, unknown>;

export function stripeEvent(type: string, object: Obj, options: { id: string; created: number }): Obj {
  return {
    id: options.id,
    object: "event",
    api_version: "2024-06-20",
    created: options.created,
    data: { object },
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type,
  };
}

/** Stripe pretty-prints event bodies with two spaces; so do we, so a naive re-serialisation differs. */
export function serializeEvent(event: Obj): string {
  return JSON.stringify(event, null, 2);
}

export interface SignedRequest {
  body: string;
  headers: { "content-type": string; "stripe-signature": string };
}

export function signedRequest(
  event: Obj | string,
  options: { secret?: string | readonly string[]; timestampSeconds?: number } = {},
): SignedRequest {
  const body = typeof event === "string" ? event : serializeEvent(event);
  const header = signStripePayload({
    secret: options.secret ?? TEST_WEBHOOK_SECRET,
    body,
    timestampSeconds: options.timestampSeconds ?? Math.floor(Date.now() / 1000),
  });
  return { body, headers: { "content-type": "application/json; charset=utf-8", "stripe-signature": header } };
}

// ---- objects -------------------------------------------------------------------------------------

export function checkoutSession(o: {
  id: string; mode: "payment" | "subscription"; amount: number; currency: string; customer?: string | null;
  email?: string; paymentIntent?: string | null; subscription?: string | null; paymentStatus?: string;
  clientReferenceId?: string; created: number;
}): Obj {
  return {
    id: o.id,
    object: "checkout.session",
    mode: o.mode,
    status: "complete",
    payment_status: o.paymentStatus ?? "paid",
    amount_total: o.amount,
    currency: o.currency,
    customer: o.customer ?? null,
    customer_details: o.email ? { email: o.email, name: "Test Buyer" } : null,
    payment_intent: o.paymentIntent ?? null,
    subscription: o.subscription ?? null,
    client_reference_id: o.clientReferenceId ?? null,
    created: o.created,
  };
}

export function subscriptionObject(o: {
  id: string; customer: string; status: string; priceId?: string; periodEnd: number; cancelAtPeriodEnd?: boolean;
  canceledAt?: number | null;
}): Obj {
  return {
    id: o.id,
    object: "subscription",
    customer: o.customer,
    status: o.status,
    cancel_at_period_end: o.cancelAtPeriodEnd ?? false,
    canceled_at: o.canceledAt ?? null,
    current_period_end: o.periodEnd,
    items: { object: "list", data: [{ id: "si_fixture_1", price: { id: o.priceId ?? "price_fixture_monthly" }, current_period_end: o.periodEnd }] },
  };
}

export function invoiceObject(o: {
  id: string; customer: string; email?: string; paymentIntent: string | null; charge?: string | null; amountPaid?: number;
  amountDue?: number; currency: string; subscription?: string | null; attemptCount?: number; created: number; paidAt?: number | null;
}): Obj {
  return {
    id: o.id,
    object: "invoice",
    customer: o.customer,
    customer_email: o.email ?? null,
    payment_intent: o.paymentIntent,
    charge: o.charge ?? null,
    amount_paid: o.amountPaid ?? 0,
    amount_due: o.amountDue ?? o.amountPaid ?? 0,
    currency: o.currency,
    subscription: o.subscription ?? null,
    attempt_count: o.attemptCount ?? 1,
    created: o.created,
    status_transitions: { paid_at: o.paidAt ?? null },
  };
}

export function chargeObject(o: {
  id: string; paymentIntent: string; amount: number; currency: string; amountRefunded: number; customer?: string | null;
  refunds?: Array<{ id: string; amount: number; status?: string; reason?: string | null; created: number }>; created: number;
  invoice?: string | null; withRefundList?: boolean;
}): Obj {
  const base: Obj = {
    id: o.id,
    object: "charge",
    payment_intent: o.paymentIntent,
    amount: o.amount,
    currency: o.currency,
    amount_refunded: o.amountRefunded,
    refunded: o.amountRefunded >= o.amount,
    customer: o.customer ?? null,
    invoice: o.invoice ?? null,
    created: o.created,
  };
  if (o.withRefundList !== false) {
    base["refunds"] = {
      object: "list",
      data: (o.refunds ?? []).map((r) => ({
        id: r.id, object: "refund", amount: r.amount, currency: o.currency, status: r.status ?? "succeeded",
        reason: r.reason ?? null, charge: o.id, payment_intent: o.paymentIntent, created: r.created,
      })),
    };
  }
  return base;
}

export function paymentIntentFailed(o: {
  id: string; amount: number; currency: string; customer?: string | null; code?: string; declineCode?: string; message?: string; created: number;
}): Obj {
  return {
    id: o.id,
    object: "payment_intent",
    amount: o.amount,
    currency: o.currency,
    customer: o.customer ?? null,
    status: "requires_payment_method",
    last_payment_error: { code: o.code ?? "card_declined", decline_code: o.declineCode ?? "insufficient_funds", message: o.message ?? "Your card has insufficient funds.", type: "card_error" },
    created: o.created,
  };
}

// ---- named scenarios (written to fixtures/ by `npm run fixtures:generate`) ------------------------

export interface FixtureFile { path: string; event: Obj }

/** Deterministic fictional scenarios. Event ids and timestamps are fixed so the files never change. */
export function fixtureFiles(): FixtureFile[] {
  const files: FixtureFile[] = [];
  const add = (dir: string, n: number, type: string, id: string, created: number, object: Obj, label = type) => {
    files.push({ path: `${dir}/${String(n).padStart(2, "0")}-${label}.json`, event: stripeEvent(type, object, { id, created }) });
  };

  // one-time USD payment, later partly refunded
  add("one-time-payment", 1, "checkout.session.completed", "evt_fx_otp_1", T0 + 100,
    checkoutSession({ id: "cs_test_fx_otp", mode: "payment", amount: 4900, currency: "usd", customer: "cus_fx_alice", email: "alice@example.test", paymentIntent: "pi_fx_otp", clientReferenceId: "order-1001", created: T0 + 100 }));
  add("one-time-payment", 2, "charge.refunded", "evt_fx_otp_2", T0 + 900,
    chargeObject({ id: "ch_fx_otp", paymentIntent: "pi_fx_otp", amount: 4900, currency: "usd", amountRefunded: 1500, customer: "cus_fx_alice", created: T0 + 110,
      refunds: [{ id: "re_fx_otp_1", amount: 1500, reason: "requested_by_customer", created: T0 + 890 }] }), "charge.refunded-partial");

  // zero-decimal currency
  add("jpy-payment", 1, "checkout.session.completed", "evt_fx_jpy_1", T0 + 200,
    checkoutSession({ id: "cs_test_fx_jpy", mode: "payment", amount: 1500, currency: "jpy", customer: "cus_fx_hiro", email: "hiro@example.test", paymentIntent: "pi_fx_jpy", created: T0 + 200 }));

  // subscription lifecycle
  add("subscription", 1, "checkout.session.completed", "evt_fx_sub_1", T0 + 1000,
    checkoutSession({ id: "cs_test_fx_sub", mode: "subscription", amount: 1200, currency: "usd", customer: "cus_fx_bob", email: "bob@example.test", subscription: "sub_fx_bob", created: T0 + 1000 }));
  add("subscription", 2, "invoice.paid", "evt_fx_sub_2", T0 + 1005,
    invoiceObject({ id: "in_fx_bob_1", customer: "cus_fx_bob", email: "bob@example.test", paymentIntent: "pi_fx_bob_1", charge: "ch_fx_bob_1", amountPaid: 1200, currency: "usd", subscription: "sub_fx_bob", created: T0 + 1004, paidAt: T0 + 1005 }));
  add("subscription", 3, "customer.subscription.updated", "evt_fx_sub_3", T0 + 1010,
    subscriptionObject({ id: "sub_fx_bob", customer: "cus_fx_bob", status: "active", periodEnd: T0 + 1010 + 30 * 86400 }), "customer.subscription.updated-active");
  add("subscription", 4, "invoice.payment_failed", "evt_fx_sub_4", T0 + 31 * 86400,
    invoiceObject({ id: "in_fx_bob_2", customer: "cus_fx_bob", paymentIntent: "pi_fx_bob_2", amountDue: 1200, currency: "usd", subscription: "sub_fx_bob", attemptCount: 1, created: T0 + 31 * 86400 }));
  add("subscription", 5, "customer.subscription.updated", "evt_fx_sub_5", T0 + 31 * 86400 + 5,
    subscriptionObject({ id: "sub_fx_bob", customer: "cus_fx_bob", status: "past_due", periodEnd: T0 + 31 * 86400 }), "customer.subscription.updated-past_due");
  add("subscription", 6, "customer.subscription.deleted", "evt_fx_sub_6", T0 + 45 * 86400,
    subscriptionObject({ id: "sub_fx_bob", customer: "cus_fx_bob", status: "canceled", periodEnd: T0 + 31 * 86400, canceledAt: T0 + 45 * 86400 }));

  // a declined card
  add("payment-failed", 1, "payment_intent.payment_failed", "evt_fx_fail_1", T0 + 2000,
    paymentIntentFailed({ id: "pi_fx_declined", amount: 2500, currency: "usd", customer: "cus_fx_carol", created: T0 + 1990 }));

  return files;
}
