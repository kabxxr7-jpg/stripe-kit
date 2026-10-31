import { describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db.ts";
import type { StripeEvent } from "../src/events.ts";
import { applyEvent, createEventHandler, EventShapeError, HANDLED_EVENT_TYPES } from "../src/handlers.ts";
import {
  chargeObject, checkoutSession, invoiceObject, paymentIntentFailed, stripeEvent, subscriptionObject, T0,
} from "../testing/fixtures.ts";

let seq = 0;
const ev = (type: string, object: Record<string, unknown>, created: number): StripeEvent =>
  stripeEvent(type, object, { id: `evt_h_${++seq}`, created }) as unknown as StripeEvent;

const one = <T = Record<string, unknown>>(db: Db, sql: string, ...args: Array<string | number>) => db.prepare(sql).get(...args) as T;
const all = (db: Db, sql: string) => db.prepare(sql).all() as Array<Record<string, unknown>>;
const count = (db: Db, table: string) => (one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${table}`)).n;

const sub = (status: string, created: number, extra: Partial<Parameters<typeof subscriptionObject>[0]> = {}) =>
  ev("customer.subscription.updated", subscriptionObject({ id: "sub_1", customer: "cus_1", status, periodEnd: created + 1000, ...extra }), created);
const subDeleted = (created: number) =>
  ev("customer.subscription.deleted", subscriptionObject({ id: "sub_1", customer: "cus_1", status: "canceled", periodEnd: created, canceledAt: created }), created);

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
}

describe("checkout.session.completed", () => {
  const paid = (created = T0) =>
    ev("checkout.session.completed", checkoutSession({ id: "cs_1", mode: "payment", amount: 4900, currency: "usd", customer: "cus_1", email: "a@example.test", paymentIntent: "pi_1", clientReferenceId: "order-7", created }), created);

  it("records customer, paid order and succeeded payment", () => {
    const db = openDb();
    expect(applyEvent(db, paid()).result).toBe("applied");
    expect(one(db, "SELECT id, email FROM customers")).toEqual({ id: "cus_1", email: "a@example.test" });
    expect(one(db, "SELECT id, status, mode, amount_total, currency, payment_intent_id, client_reference_id FROM orders")).toEqual({
      id: "cs_1", status: "paid", mode: "payment", amount_total: 4900, currency: "usd", payment_intent_id: "pi_1", client_reference_id: "order-7",
    });
    expect(one(db, "SELECT payment_intent_id, amount, currency, status, amount_refunded FROM payments")).toEqual({
      payment_intent_id: "pi_1", amount: 4900, currency: "usd", status: "succeeded", amount_refunded: 0,
    });
  });

  it("applying the same event twice changes nothing (idempotent without the dedupe store)", () => {
    const db = openDb();
    const e = paid();
    applyEvent(db, e);
    const snapshot = JSON.stringify([all(db, "SELECT * FROM orders"), all(db, "SELECT * FROM payments"), all(db, "SELECT * FROM customers")]);
    applyEvent(db, e);
    expect(JSON.stringify([all(db, "SELECT * FROM orders"), all(db, "SELECT * FROM payments"), all(db, "SELECT * FROM customers")])).toBe(snapshot);
  });

  it("an unpaid (async method) session is a pending order with no payment; the paid one completes it", () => {
    const db = openDb();
    applyEvent(db, ev("checkout.session.completed", checkoutSession({ id: "cs_1", mode: "payment", amount: 4900, currency: "usd", customer: "cus_1", paymentIntent: "pi_1", paymentStatus: "unpaid", created: T0 }), T0));
    expect(one(db, "SELECT status FROM orders")).toEqual({ status: "pending" });
    expect(count(db, "payments")).toBe(0);
    applyEvent(db, paid(T0 + 60));
    expect(one(db, "SELECT status FROM orders")).toEqual({ status: "paid" });
    expect(count(db, "payments")).toBe(1);
  });

  it("an order never goes from paid back to pending", () => {
    const db = openDb();
    applyEvent(db, paid(T0 + 60));
    applyEvent(db, ev("checkout.session.completed", checkoutSession({ id: "cs_1", mode: "payment", amount: 4900, currency: "usd", customer: "cus_1", paymentIntent: "pi_1", paymentStatus: "unpaid", created: T0 }), T0));
    expect(one(db, "SELECT status FROM orders")).toEqual({ status: "paid" });
  });

  it("guest checkout (no customer) works", () => {
    const db = openDb();
    applyEvent(db, ev("checkout.session.completed", checkoutSession({ id: "cs_g", mode: "payment", amount: 500, currency: "usd", paymentIntent: "pi_g", created: T0 }), T0));
    expect(count(db, "customers")).toBe(0);
    expect(one(db, "SELECT customer_id FROM orders")).toEqual({ customer_id: null });
  });

  it("zero-decimal currency amounts are stored as given, not scaled", () => {
    const db = openDb();
    applyEvent(db, ev("checkout.session.completed", checkoutSession({ id: "cs_j", mode: "payment", amount: 1500, currency: "JPY", paymentIntent: "pi_j", created: T0 }), T0));
    expect(one(db, "SELECT amount, currency FROM payments")).toEqual({ amount: 1500, currency: "jpy" });
  });

  it("a subscription checkout leaves a pending stub that a real subscription event replaces", () => {
    const db = openDb();
    applyEvent(db, ev("checkout.session.completed", checkoutSession({ id: "cs_s", mode: "subscription", amount: 1200, currency: "usd", customer: "cus_1", subscription: "sub_1", created: T0 }), T0));
    expect(one(db, "SELECT status, last_event_created FROM subscriptions")).toEqual({ status: "pending", last_event_created: 0 });
    expect(count(db, "payments")).toBe(0);
    applyEvent(db, sub("active", T0 + 5));
    expect(one(db, "SELECT status FROM subscriptions")).toEqual({ status: "active" });
  });

  it("a late subscription checkout does not overwrite a newer real status", () => {
    const db = openDb();
    applyEvent(db, sub("past_due", T0 + 500));
    applyEvent(db, ev("checkout.session.completed", checkoutSession({ id: "cs_s", mode: "subscription", amount: 1200, currency: "usd", customer: "cus_1", subscription: "sub_1", created: T0 }), T0));
    expect(one(db, "SELECT status FROM subscriptions")).toEqual({ status: "past_due" });
    expect(one(db, "SELECT subscription_id FROM orders")).toEqual({ subscription_id: "sub_1" });
  });
});

describe("customer.subscription.updated / deleted", () => {
  it("follows a normal lifecycle", () => {
    const db = openDb();
    applyEvent(db, sub("active", T0 + 10));
    applyEvent(db, sub("past_due", T0 + 20));
    applyEvent(db, sub("active", T0 + 30, { cancelAtPeriodEnd: true }));
    expect(one(db, "SELECT status, cancel_at_period_end, price_id, current_period_end FROM subscriptions")).toEqual({
      status: "active", cancel_at_period_end: 1, price_id: "price_fixture_monthly", current_period_end: T0 + 1030,
    });
    applyEvent(db, subDeleted(T0 + 40));
    expect(one(db, "SELECT status, canceled_at FROM subscriptions")).toEqual({ status: "canceled", canceled_at: T0 + 40 });
  });

  it("an older update delivered late is ignored (never moves backwards)", () => {
    const db = openDb();
    applyEvent(db, sub("past_due", T0 + 20));
    const late = applyEvent(db, sub("active", T0 + 10));
    expect(late.result).toBe("stale");
    expect(one(db, "SELECT status, last_event_created FROM subscriptions")).toEqual({ status: "past_due", last_event_created: T0 + 20 });
  });

  it("a stale 'active' update after the deletion cannot revive the subscription", () => {
    const db = openDb();
    applyEvent(db, subDeleted(T0 + 30));
    expect(applyEvent(db, sub("active", T0 + 20)).result).toBe("stale");
    expect(applyEvent(db, sub("active", T0 + 99)).result).toBe("stale"); // even a later-stamped one: canceled is terminal
    expect(one(db, "SELECT status FROM subscriptions")).toEqual({ status: "canceled" });
  });

  it("a deletion is applied even if an update stamped later was delivered first", () => {
    const db = openDb();
    applyEvent(db, sub("active", T0 + 50));
    expect(applyEvent(db, subDeleted(T0 + 40)).result).toBe("applied");
    expect(one(db, "SELECT status FROM subscriptions")).toEqual({ status: "canceled" });
  });

  it("events with an equal timestamp: the last one delivered wins (documented tie rule)", () => {
    const db = openDb();
    applyEvent(db, sub("active", T0 + 10));
    applyEvent(db, sub("past_due", T0 + 10));
    expect(one(db, "SELECT status FROM subscriptions")).toEqual({ status: "past_due" });
  });

  it("every delivery order of three updates ends on the newest one", () => {
    const events = [sub("trialing", T0 + 10), sub("past_due", T0 + 20), sub("active", T0 + 30)];
    for (const order of permutations(events)) {
      const db = openDb();
      for (const e of order) applyEvent(db, e);
      expect(one(db, "SELECT status, last_event_created FROM subscriptions"), order.map((e) => e.created).join(",")).toEqual({ status: "active", last_event_created: T0 + 30 });
    }
  });

  it("every delivery order of {checkout, update, deletion} ends canceled with the order and customer recorded", () => {
    const checkout = ev("checkout.session.completed", checkoutSession({ id: "cs_s", mode: "subscription", amount: 1200, currency: "usd", customer: "cus_1", email: "a@example.test", subscription: "sub_1", created: T0 }), T0);
    for (const order of permutations([checkout, sub("active", T0 + 10), subDeleted(T0 + 20)])) {
      const db = openDb();
      for (const e of order) applyEvent(db, e);
      expect(one(db, "SELECT status FROM subscriptions"), order.map((e) => e.type).join(",")).toEqual({ status: "canceled" });
      expect(count(db, "orders")).toBe(1);
      expect(one(db, "SELECT email FROM customers")).toEqual({ email: "a@example.test" });
    }
  });
});

describe("payments: invoice.paid, invoice.payment_failed, payment_intent.payment_failed", () => {
  const paidInvoice = (created: number, extra: Partial<Parameters<typeof invoiceObject>[0]> = {}) =>
    ev("invoice.paid", invoiceObject({ id: "in_1", customer: "cus_1", email: "a@example.test", paymentIntent: "pi_1", charge: "ch_1", amountPaid: 1200, currency: "usd", created, paidAt: created, ...extra }), created);
  const failedInvoice = (created: number) =>
    ev("invoice.payment_failed", invoiceObject({ id: "in_1", customer: "cus_1", paymentIntent: "pi_1", amountDue: 1200, currency: "usd", attemptCount: 2, created }), created);
  const failedIntent = (created: number) => ev("payment_intent.payment_failed", paymentIntentFailed({ id: "pi_1", amount: 1200, currency: "usd", customer: "cus_1", created }), created);

  it("invoice.paid records a succeeded payment with its charge and invoice", () => {
    const db = openDb();
    applyEvent(db, paidInvoice(T0 + 10));
    expect(one(db, "SELECT payment_intent_id, charge_id, invoice_id, customer_id, amount, status, paid_at FROM payments")).toEqual({
      payment_intent_id: "pi_1", charge_id: "ch_1", invoice_id: "in_1", customer_id: "cus_1", amount: 1200, status: "succeeded", paid_at: T0 + 10,
    });
  });

  it("invoice.paid with no payment intent or a zero amount is ignored, not an error", () => {
    const db = openDb();
    expect(applyEvent(db, paidInvoice(T0, { paymentIntent: null }))).toMatchObject({ result: "ignored" });
    expect(applyEvent(db, paidInvoice(T0, { amountPaid: 0 }))).toMatchObject({ result: "ignored" });
    expect(count(db, "payments")).toBe(0);
  });

  it("invoice.payment_failed records a failed payment with the attempt", () => {
    const db = openDb();
    applyEvent(db, failedInvoice(T0 + 10));
    expect(one(db, "SELECT status, failure_code, failure_message, amount FROM payments")).toEqual({
      status: "failed", failure_code: "invoice_payment_failed", failure_message: "invoice payment failed (attempt 2)", amount: 1200,
    });
  });

  it("payment_intent.payment_failed records the decline code and message", () => {
    const db = openDb();
    applyEvent(db, failedIntent(T0 + 10));
    expect(one(db, "SELECT status, failure_code, failure_message FROM payments")).toEqual({
      status: "failed", failure_code: "insufficient_funds", failure_message: "Your card has insufficient funds.",
    });
  });

  it("a failure followed by a successful retry ends succeeded with the failure cleared", () => {
    const db = openDb();
    applyEvent(db, failedIntent(T0 + 10));
    applyEvent(db, paidInvoice(T0 + 100));
    expect(one(db, "SELECT status, failure_code, failure_message, charge_id FROM payments")).toEqual({
      status: "succeeded", failure_code: null, failure_message: null, charge_id: "ch_1",
    });
  });

  it("a late failure cannot undo a success (out of order)", () => {
    const db = openDb();
    applyEvent(db, paidInvoice(T0 + 100));
    expect(applyEvent(db, failedIntent(T0 + 10)).result).toBe("stale");
    expect(applyEvent(db, failedInvoice(T0 + 20)).result).toBe("stale");
    expect(one(db, "SELECT status, failure_code FROM payments")).toEqual({ status: "succeeded", failure_code: null });
  });

  it("every delivery order of {failed, paid} ends succeeded", () => {
    for (const order of permutations([failedIntent(T0 + 10), failedInvoice(T0 + 20), paidInvoice(T0 + 30)])) {
      const db = openDb();
      for (const e of order) applyEvent(db, e);
      expect(one(db, "SELECT status FROM payments"), order.map((e) => e.type).join(",")).toEqual({ status: "succeeded" });
    }
  });
});

describe("charge.refunded", () => {
  const charge = (amountRefunded: number, created: number, extra: Partial<Parameters<typeof chargeObject>[0]> = {}) =>
    ev("charge.refunded", chargeObject({ id: "ch_1", paymentIntent: "pi_1", amount: 4900, currency: "usd", amountRefunded, customer: "cus_1", created: T0,
      refunds: [{ id: "re_1", amount: amountRefunded, created }], ...extra }), created);
  const paid = (created: number) =>
    ev("checkout.session.completed", checkoutSession({ id: "cs_1", mode: "payment", amount: 4900, currency: "usd", customer: "cus_1", paymentIntent: "pi_1", created }), created);

  it("a partial refund marks the payment partially_refunded and stores the refund", () => {
    const db = openDb();
    applyEvent(db, paid(T0 + 10));
    applyEvent(db, charge(1500, T0 + 20));
    expect(one(db, "SELECT status, amount_refunded, charge_id FROM payments")).toEqual({ status: "partially_refunded", amount_refunded: 1500, charge_id: "ch_1" });
    expect(one(db, "SELECT id, amount, currency, status, charge_id, payment_intent_id FROM refunds")).toEqual({
      id: "re_1", amount: 1500, currency: "usd", status: "succeeded", charge_id: "ch_1", payment_intent_id: "pi_1",
    });
  });

  it("refunding the whole amount marks it refunded", () => {
    const db = openDb();
    applyEvent(db, paid(T0 + 10));
    applyEvent(db, charge(1500, T0 + 20));
    applyEvent(db, charge(4900, T0 + 30, { refunds: [{ id: "re_1", amount: 1500, created: T0 + 20 }, { id: "re_2", amount: 3400, created: T0 + 30 }] }));
    expect(one(db, "SELECT status, amount_refunded FROM payments")).toEqual({ status: "refunded", amount_refunded: 4900 });
    expect(count(db, "refunds")).toBe(2);
  });

  it("an older charge snapshot delivered late cannot lower the refunded amount", () => {
    const db = openDb();
    applyEvent(db, charge(4900, T0 + 30, { refunds: [{ id: "re_1", amount: 1500, created: T0 + 20 }, { id: "re_2", amount: 3400, created: T0 + 30 }] }));
    applyEvent(db, charge(1500, T0 + 20));
    expect(one(db, "SELECT status, amount_refunded FROM payments")).toEqual({ status: "refunded", amount_refunded: 4900 });
  });

  it("a refund that arrives before the payment's own event is kept, and the late 'succeeded' does not undo it", () => {
    const db = openDb();
    applyEvent(db, charge(1500, T0 + 20));
    applyEvent(db, paid(T0 + 10));
    applyEvent(db, ev("invoice.paid", invoiceObject({ id: "in_1", customer: "cus_1", paymentIntent: "pi_1", charge: "ch_1", amountPaid: 4900, currency: "usd", created: T0 + 5 }), T0 + 5));
    expect(one(db, "SELECT status, amount_refunded, invoice_id FROM payments")).toEqual({ status: "partially_refunded", amount_refunded: 1500, invoice_id: "in_1" });
  });

  it("a charge without the refunds list (newer API versions) records the total only", () => {
    const db = openDb();
    applyEvent(db, paid(T0 + 10));
    applyEvent(db, charge(1500, T0 + 20, { withRefundList: false }));
    expect(count(db, "refunds")).toBe(0);
    expect(one(db, "SELECT status, amount_refunded FROM payments")).toEqual({ status: "partially_refunded", amount_refunded: 1500 });
  });

  it("a still-open refund can be updated, a settled one cannot be reopened", () => {
    const db = openDb();
    applyEvent(db, charge(1500, T0 + 20, { refunds: [{ id: "re_1", amount: 1500, status: "pending", created: T0 + 20 }] }));
    expect(one(db, "SELECT status FROM refunds")).toEqual({ status: "pending" });
    applyEvent(db, charge(1500, T0 + 30, { refunds: [{ id: "re_1", amount: 1500, status: "succeeded", created: T0 + 20 }] }));
    expect(one(db, "SELECT status FROM refunds")).toEqual({ status: "succeeded" });
    applyEvent(db, charge(1500, T0 + 25, { refunds: [{ id: "re_1", amount: 1500, status: "pending", created: T0 + 20 }] }));
    expect(one(db, "SELECT status FROM refunds")).toEqual({ status: "succeeded" });
  });

  it("a charge from the legacy Charges API (no payment_intent) is ignored", () => {
    const db = openDb();
    const e = ev("charge.refunded", { ...chargeObject({ id: "ch_old", paymentIntent: "x", amount: 100, currency: "usd", amountRefunded: 100, created: T0 }), payment_intent: null }, T0);
    expect(applyEvent(db, e)).toMatchObject({ result: "ignored" });
  });
});

describe("robustness", () => {
  it("event types without a handler are ignored; every documented type has one", () => {
    const db = openDb();
    expect(applyEvent(db, ev("customer.created", { id: "cus_x" }, T0))).toMatchObject({ result: "ignored" });
    expect(applyEvent(db, ev("constructor", { id: "x" }, T0))).toMatchObject({ result: "ignored" }); // no prototype lookup
    expect([...HANDLED_EVENT_TYPES].sort()).toEqual([
      "charge.refunded", "checkout.session.completed", "customer.subscription.deleted", "customer.subscription.updated",
      "invoice.paid", "invoice.payment_failed", "payment_intent.payment_failed",
    ]);
  });

  it("a malformed object throws and leaves no partial writes", () => {
    const db = openDb();
    const bad = ev("charge.refunded", chargeObject({ id: "ch_1", paymentIntent: "pi_1", amount: 4900, currency: "usd", amountRefunded: 100, customer: "cus_1", created: T0 }), T0);
    ((bad.data.object["refunds"] as { data: unknown[] }).data as unknown[]).push({ amount: 100 }); // a refund without an id
    expect(() => applyEvent(db, bad)).toThrow(EventShapeError);
    expect(count(db, "customers")).toBe(0); // the customer upsert from the same event was rolled back
    expect(count(db, "payments")).toBe(0);
  });

  it("rejects float or negative amounts instead of storing them", () => {
    const db = openDb();
    expect(() => applyEvent(db, ev("checkout.session.completed", { ...checkoutSession({ id: "cs_1", mode: "payment", amount: 1, currency: "usd", paymentIntent: "pi_1", created: T0 }), currency: "us" }, T0))).toThrow(EventShapeError);
    const floaty = ev("payment_intent.payment_failed", { ...paymentIntentFailed({ id: "pi_1", amount: 1, currency: "usd", created: T0 }), amount: 12.5 }, T0);
    expect(() => applyEvent(db, floaty)).toThrow(EventShapeError);
    const negative = ev("payment_intent.payment_failed", { ...paymentIntentFailed({ id: "pi_1", amount: 1, currency: "usd", created: T0 }), amount: -5 }, T0);
    expect(() => applyEvent(db, negative)).toThrow(EventShapeError);
  });

  it("createEventHandler reports outcomes and propagates errors", () => {
    const db = openDb();
    const seen: string[] = [];
    const handler = createEventHandler(db, { onOutcome: (e, o) => void seen.push(`${e.type}:${o.result}`) });
    handler(sub("active", T0 + 10));
    handler(sub("active", T0 + 5));
    expect(seen).toEqual(["customer.subscription.updated:applied", "customer.subscription.updated:stale"]);
    expect(() => handler(ev("customer.subscription.updated", { id: "sub_2" }, T0))).toThrow(EventShapeError);
  });
});
