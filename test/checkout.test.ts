import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  checkoutParams, createCheckoutSession, encodeForm, expireCheckoutSession, retrieveCheckoutSession, StripeApiError,
  type CreateCheckoutInput, type StripeClientOptions,
} from "../src/stripe-api.ts";
import { startFakeStripe, type FakeStripe } from "../testing/fake-stripe.ts";

let fake: FakeStripe;
const delays: number[] = [];
const client = (extra: Partial<StripeClientOptions> = {}): StripeClientOptions => ({
  apiKey: fake.apiKey, baseUrl: fake.baseUrl, sleep: async (ms) => void delays.push(ms), ...extra,
});
beforeAll(async () => { fake = await startFakeStripe(); });
afterAll(() => fake.close());
beforeEach(() => { fake.requests.length = 0; fake.failNext(0, 500); delays.length = 0; });

const urls = { successUrl: "https://shop.example.test/ok?s={CHECKOUT_SESSION_ID}", cancelUrl: "https://shop.example.test/cancel" };
const payment = (extra: Partial<CreateCheckoutInput> = {}): CreateCheckoutInput => ({
  mode: "payment", ...urls, lineItems: [{ name: "Pro license", unitAmount: 4900, currency: "usd", quantity: 2 }], ...extra,
});
const subscription = (extra: Partial<CreateCheckoutInput> = {}): CreateCheckoutInput => ({
  mode: "subscription", ...urls, lineItems: [{ name: "Pro plan", unitAmount: 1200, currency: "usd", quantity: 1, recurring: { interval: "month" } }], ...extra,
});
const posts = () => fake.requests.filter((r) => r.method === "POST" && r.path === "/v1/checkout/sessions");

describe("encodeForm", () => {
  it("uses Stripe's bracket notation for nesting and arrays", () => {
    const encoded = encodeForm({ mode: "payment", line_items: [{ quantity: 1, price_data: { currency: "usd" } }], metadata: { a: "b c" } });
    expect(decodeURIComponent(encoded.replace(/\+/g, " "))).toBe("mode=payment&line_items[0][quantity]=1&line_items[0][price_data][currency]=usd&metadata[a]=b c");
  });
  it("skips undefined and null, refuses floats", () => {
    expect(encodeForm({ a: undefined, b: null, c: 1 })).toBe("c=1");
    expect(() => encodeForm({ amount: 12.5 })).toThrow(RangeError);
  });
});

describe("one-time payment session", () => {
  it("sends an authenticated, form-encoded POST with an Idempotency-Key and the amounts in minor units", async () => {
    const { data } = await createCheckoutSession(client(), payment({ clientReferenceId: "order-1001", metadata: { cart: "c_9" }, customerEmail: "buyer@example.test" }));
    const [req] = posts();
    expect(req?.headers.authorization).toBe(`Bearer ${fake.apiKey}`);
    expect(req?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(req?.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(req?.form).toMatchObject({
      mode: "payment", success_url: urls.successUrl, cancel_url: urls.cancelUrl, client_reference_id: "order-1001",
      customer_email: "buyer@example.test", metadata: { cart: "c_9" },
      line_items: [{ quantity: "2", price_data: { currency: "usd", unit_amount: "4900", product_data: { name: "Pro license" } } }],
    });
    expect(data).toMatchObject({ object: "checkout.session", mode: "payment", amount_total: 9800, currency: "usd", client_reference_id: "order-1001", status: "open" });
    expect(data.url).toContain(data.id);
  });

  it("accepts an existing price id", async () => {
    await createCheckoutSession(client(), payment({ lineItems: [{ price: "price_123abc", quantity: 1 }] }));
    expect(posts()[0]?.form["line_items"]).toEqual([{ price: "price_123abc", quantity: "1" }]);
  });

  it("sends zero-decimal amounts unscaled: JPY 1500 is 1500, not 150000", async () => {
    const { data } = await createCheckoutSession(client(), payment({ lineItems: [{ name: "Ticket", unitAmount: 1500, currency: "JPY", quantity: 1 }] }));
    expect(posts()[0]?.form["line_items"]).toMatchObject([{ price_data: { currency: "jpy", unit_amount: "1500" } }]);
    expect(data.amount_total).toBe(1500);
  });

  it("sends the Stripe-Version header only when asked", async () => {
    await createCheckoutSession(client(), payment());
    await createCheckoutSession(client({ apiVersion: "2024-06-20" }), payment());
    expect(posts()[0]?.headers["stripe-version"]).toBeUndefined();
    expect(posts()[1]?.headers["stripe-version"]).toBe("2024-06-20");
  });
});

describe("subscription session", () => {
  it("sends a recurring price", async () => {
    const { data } = await createCheckoutSession(client(), subscription({ customer: "cus_123" }));
    expect(posts()[0]?.form).toMatchObject({
      mode: "subscription", customer: "cus_123",
      line_items: [{ price_data: { currency: "usd", unit_amount: "1200", recurring: { interval: "month" } } }],
    });
    expect(data).toMatchObject({ mode: "subscription", amount_total: 1200 });
  });

  it("supports an interval count", async () => {
    await createCheckoutSession(client(), subscription({ lineItems: [{ name: "Quarterly", unitAmount: 3000, currency: "usd", quantity: 1, recurring: { interval: "month", intervalCount: 3 } }] }));
    expect(posts()[0]?.form["line_items"]).toMatchObject([{ price_data: { recurring: { interval: "month", interval_count: "3" } } }]);
  });
});

describe("idempotency key on creates", () => {
  it("two calls with the same key return the same session and are flagged as replays", async () => {
    const a = await createCheckoutSession(client(), payment({ idempotencyKey: "cart-42" }));
    const b = await createCheckoutSession(client(), payment({ idempotencyKey: "cart-42" }));
    expect(b.data.id).toBe(a.data.id);
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(true);
    expect(posts().map((r) => r.headers["idempotency-key"])).toEqual(["cart-42", "cart-42"]);
  });

  it("reusing a key with different parameters is an error, not a silent second session", async () => {
    await createCheckoutSession(client(), payment({ idempotencyKey: "cart-43" }));
    const error = await createCheckoutSession(client(), payment({ idempotencyKey: "cart-43", clientReferenceId: "changed" })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StripeApiError);
    expect(error).toMatchObject({ status: 400, type: "idempotency_error" });
  });

  it("without a caller key each call gets a fresh one", async () => {
    await createCheckoutSession(client(), payment());
    await createCheckoutSession(client(), payment());
    const keys = posts().map((r) => r.headers["idempotency-key"]);
    expect(new Set(keys).size).toBe(2);
  });
});

describe("retries", () => {
  it("retries a 500 twice with the SAME idempotency key and creates exactly one session", async () => {
    fake.failNext(2, 500);
    const before = fake.sessions.size;
    const { data } = await createCheckoutSession(client(), payment());
    expect(data.id).toMatch(/^cs_test_/);
    const keys = posts().map((r) => r.headers["idempotency-key"]);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
    expect(fake.sessions.size).toBe(before + 1);
    expect(delays).toEqual([500, 1000]);
  });

  it("recovers from a dropped connection", async () => {
    fake.failNext(1, 0);
    const { data } = await createCheckoutSession(client(), payment());
    expect(data.id).toMatch(/^cs_test_/);
    expect(posts()).toHaveLength(2);
  });

  it("gives up after maxRetries and reports the Stripe error", async () => {
    fake.failNext(10, 503);
    const error = await createCheckoutSession(client({ maxRetries: 1 }), payment()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StripeApiError);
    expect((error as StripeApiError).status).toBe(503);
    expect(posts()).toHaveLength(2);
  });

  it("does not retry a client error", async () => {
    const error = await createCheckoutSession(client({ apiKey: "sk_test_wrong_key_value" }), payment()).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 401, type: "invalid_request_error", code: "api_key_invalid" });
    expect(posts()).toHaveLength(1);
    expect(String((error as Error).message)).not.toContain("wrong_key_value");
  });
});

describe("validation before any request is sent", () => {
  const bad: Array<[string, CreateCheckoutInput, RegExp]> = [
    ["fractional amount", payment({ lineItems: [{ name: "x", unitAmount: 19.99, currency: "usd", quantity: 1 }] }), /integer/],
    ["negative amount", payment({ lineItems: [{ name: "x", unitAmount: -5, currency: "usd", quantity: 1 }] }), /negative/],
    ["zero quantity", payment({ lineItems: [{ name: "x", unitAmount: 5, currency: "usd", quantity: 0 }] }), /quantity/],
    ["no items", payment({ lineItems: [] }), /line item/],
    ["recurring in payment mode", payment({ lineItems: [{ name: "x", unitAmount: 5, currency: "usd", quantity: 1, recurring: { interval: "month" } }] }), /payment mode/],
    ["subscription without recurring", subscription({ lineItems: [{ name: "x", unitAmount: 5, currency: "usd", quantity: 1 }] }), /needs recurring/],
    ["mixed currencies", payment({ lineItems: [{ name: "a", unitAmount: 5, currency: "usd", quantity: 1 }, { name: "b", unitAmount: 5, currency: "eur", quantity: 1 }] }), /one currency/],
    ["bad currency", payment({ lineItems: [{ name: "a", unitAmount: 5, currency: "dollars", quantity: 1 }] }), /currency/],
    ["customer and customerEmail", payment({ customer: "cus_1", customerEmail: "a@example.test" }), /not both/],
    ["relative success url", payment({ successUrl: "/thanks" }), /absolute URL/],
    ["javascript: url", payment({ cancelUrl: "javascript:alert(1)" }), /http/],
    ["bad price id", payment({ lineItems: [{ price: "prod_123", quantity: 1 }] }), /price id/],
    ["metadata value too long", payment({ metadata: { k: "x".repeat(501) } }), /metadata/],
  ];
  it.each(bad)("rejects %s", async (_name, input, pattern) => {
    expect(() => checkoutParams(input)).toThrow(pattern);
    await expect(createCheckoutSession(client(), input)).rejects.toThrow(pattern);
    expect(fake.requests).toHaveLength(0);
  });
});

describe("retrieve and expire", () => {
  it("reads a session back and expires it", async () => {
    const { data } = await createCheckoutSession(client(), payment());
    expect((await retrieveCheckoutSession(client(), data.id)).status).toBe("open");
    expect((await expireCheckoutSession(client(), data.id)).status).toBe("expired");
    expect((await retrieveCheckoutSession(client(), data.id)).status).toBe("expired");
  });
  it("reports a missing session as a 404 StripeApiError and rejects malformed ids locally", async () => {
    await expect(retrieveCheckoutSession(client(), "cs_test_nope")).rejects.toMatchObject({ status: 404, code: "resource_missing" });
    await expect(retrieveCheckoutSession(client(), "../etc/passwd")).rejects.toThrow(/not a checkout session id/);
  });
});
