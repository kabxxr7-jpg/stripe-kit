import { describe, expect, it } from "vitest";
import { createMemoryStore, type Store } from "../src/idempotency.ts";
import { handleStripeWebhook, type EventHandler } from "../src/webhook.ts";
import { signStripePayload } from "../src/verify.ts";
import { serializeEvent, signedRequest, stripeEvent, TEST_WEBHOOK_SECRET as SECRET, T0 } from "../testing/fixtures.ts";

const NOW_MS = (T0 + 10) * 1000;
const event = (id = "evt_1", created = T0) => stripeEvent("invoice.paid", { id: "in_1" }, { id, created });
const signed = (e = event(), secret: string | string[] = SECRET, t = T0 + 10) => signedRequest(e, { secret, timestampSeconds: t });

function setup(handler?: EventHandler, store: Store = createMemoryStore({ now: () => NOW_MS })) {
  const calls: string[] = [];
  const h: EventHandler = handler ?? ((e) => void calls.push(e.id));
  const deliver = (req: { body: unknown; headers: Record<string, string> | Headers }, extra: Record<string, unknown> = {}) =>
    handleStripeWebhook({ rawBody: req.body, headers: req.headers, secret: SECRET, store, handler: h, nowMs: NOW_MS, ...extra });
  return { calls, deliver, store };
}

describe("status codes and handler calls", () => {
  it("valid event: 200, handler runs once with the parsed event", async () => {
    const { calls, deliver } = setup();
    const r = await deliver(signed());
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ received: true, status: "ok" });
    expect(calls).toEqual(["evt_1"]);
  });

  it("accepts a Buffer body and a Web Headers object", async () => {
    const { calls, deliver } = setup();
    const req = signed();
    const r = await deliver({ body: Buffer.from(req.body), headers: new Headers(req.headers) });
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("header lookup is case-insensitive", async () => {
    const { deliver } = setup();
    const req = signed();
    const r = await deliver({ body: req.body, headers: { "Stripe-Signature": req.headers["stripe-signature"] } });
    expect(r.status).toBe(200);
  });

  it("missing signature header: 400, handler not run", async () => {
    const { calls, deliver } = setup();
    const r = await deliver({ body: signed().body, headers: {} });
    expect(r).toMatchObject({ status: 400, body: { error: "invalid_signature" }, reason: "missing_header" });
    expect(calls).toEqual([]);
  });

  it("unknown event types are acknowledged (the handler decides what to do)", async () => {
    const { calls, deliver } = setup();
    const r = await deliver(signed(stripeEvent("some.future.event", {}, { id: "evt_f", created: T0 })));
    expect(r.status).toBe(200);
    expect(calls).toEqual(["evt_f"]);
  });
});

describe("classic bug: wrong secret", () => {
  it("is rejected with 400 and the handler never runs; a later valid delivery still works", async () => {
    const { calls, deliver } = setup();
    const bad = await deliver(signed(event(), "whsec_test_the_wrong_one"));
    expect(bad).toMatchObject({ status: 400, reason: "signature_mismatch" });
    expect(calls).toEqual([]);
    expect((await deliver(signed())).status).toBe(200); // the failed attempt did not poison the event id
    expect(calls).toEqual(["evt_1"]);
  });

  it("the response does not say which check failed", async () => {
    const { deliver } = setup();
    const a = await deliver(signed(event(), "whsec_test_the_wrong_one"));
    const b = await deliver(signed(event(), SECRET, T0 - 100000));
    expect(a.body).toEqual(b.body);
  });

  it("accepts either secret while one is being rolled", async () => {
    const { deliver, calls } = setup();
    const r = await deliver(signed(event("evt_roll"), "whsec_test_previous"), { secret: [SECRET, "whsec_test_previous"] });
    expect(r.status).toBe(200);
    expect(calls).toEqual(["evt_roll"]);
  });
});

describe("classic bug: body changed before verifying", () => {
  it("a parsed-then-re-serialised body fails even though the event is genuine", async () => {
    const { calls, deliver } = setup();
    const req = signed();
    const reserialised = JSON.stringify(JSON.parse(req.body));
    expect(reserialised).not.toBe(req.body);
    const r = await deliver({ body: reserialised, headers: req.headers });
    expect(r).toMatchObject({ status: 400, reason: "signature_mismatch" });
    expect(calls).toEqual([]);
  });

  it("changed whitespace, a trailing newline and an altered amount all fail", async () => {
    const { deliver } = setup();
    const req = signed();
    for (const body of [req.body + "\n", req.body.replace(/\n\s*/g, ""), req.body.replace("in_1", "in_2")]) {
      expect((await deliver({ body, headers: req.headers })).status).toBe(400);
    }
  });

  it("a body that was already parsed by middleware is refused outright, not verified", async () => {
    const { deliver, calls } = setup();
    const req = signed();
    const r = await deliver({ body: JSON.parse(req.body), headers: req.headers });
    expect(r).toMatchObject({ status: 400, reason: "body_not_raw" });
    expect(calls).toEqual([]);
  });

  it("non-ASCII bodies verify as bytes, not as re-encoded text", async () => {
    const { calls, deliver } = setup();
    const e = stripeEvent("invoice.paid", { id: "in_1", customer_name: "Zoë Müller ✨ \\u00e9" }, { id: "evt_utf8", created: T0 });
    const req = signed(e);
    expect((await deliver({ body: Buffer.from(req.body, "utf8"), headers: req.headers })).status).toBe(200);
    expect(calls).toEqual(["evt_utf8"]);
  });
});

describe("classic bug: replay and stale timestamps", () => {
  it("the same signed request delivered twice runs the handler once; the second is a 200 duplicate", async () => {
    const { calls, deliver } = setup();
    const req = signed();
    expect((await deliver(req)).body).toMatchObject({ status: "ok" });
    const second = await deliver(req);
    expect(second).toMatchObject({ status: 200, body: { received: true, status: "duplicate" } });
    expect(calls).toEqual(["evt_1"]);
  });

  it("a captured request replayed after the tolerance window is rejected before any dedupe", async () => {
    const { calls, deliver } = setup();
    const req = signed(event(), SECRET, T0 - 400); // 410 s old at NOW
    expect(await deliver(req)).toMatchObject({ status: 400, reason: "timestamp_too_old" });
    expect(calls).toEqual([]);
  });

  it("a timestamp from the future is rejected", async () => {
    const { deliver } = setup();
    expect(await deliver(signed(event(), SECRET, T0 + 10 + 1000))).toMatchObject({ status: 400, reason: "timestamp_in_future" });
  });

  it("the tolerance is configurable", async () => {
    const { deliver } = setup();
    const req = signed(event(), SECRET, T0 - 100);
    expect((await deliver(req, { toleranceSeconds: 60 })).status).toBe(400);
    expect((await deliver(req, { toleranceSeconds: 600 })).status).toBe(200);
  });

  it("a Stripe retry (new timestamp, same event id, same body) is still a duplicate", async () => {
    const { calls, deliver } = setup();
    const e = event();
    await deliver(signed(e, SECRET, T0 + 10));
    expect((await deliver(signed(e, SECRET, T0 + 20))).body).toMatchObject({ status: "duplicate" });
    expect(calls).toHaveLength(1);
  });
});

describe("out-of-order delivery at the receiver", () => {
  it("events arrive in any order and each id is handled exactly once", async () => {
    const { calls, deliver } = setup();
    const events = [event("evt_a", T0 + 1), event("evt_b", T0 + 2), event("evt_c", T0 + 3)];
    for (const i of [2, 0, 1, 2, 1, 0]) await deliver(signed(events[i] as ReturnType<typeof event>));
    expect(calls).toEqual(["evt_c", "evt_a", "evt_b"]);
  });
});

describe("duplicate delivery while the first is still in flight", () => {
  it("the second delivery gets 409 (so Stripe retries) and the handler runs once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let runs = 0;
    const { deliver } = setup(async () => {
      runs += 1;
      await gate;
    });
    const req = signed();
    const first = deliver(req);
    await new Promise((r) => setImmediate(r)); // let the first reach the handler
    const second = await deliver(req);
    expect(second).toMatchObject({ status: 409, body: { status: "in_flight" } });
    release();
    expect((await first).status).toBe(200);
    expect((await deliver(req)).body).toMatchObject({ status: "duplicate" });
    expect(runs).toBe(1);
  });

  it("if the first worker then fails, the retry runs the handler again", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let runs = 0;
    const { deliver } = setup(async () => {
      runs += 1;
      if (runs === 1) {
        await gate;
        throw new Error("first worker blew up");
      }
    });
    const req = signed();
    const first = deliver(req);
    await new Promise((r) => setImmediate(r));
    expect((await deliver(req)).status).toBe(409);
    release();
    expect((await first).status).toBe(500);
    expect((await deliver(req)).status).toBe(200);
    expect(runs).toBe(2);
  });
});

describe("handler failure and crash recovery", () => {
  it("a throwing handler gives 500 without leaking the error text, and a retry re-runs it", async () => {
    let fail = true;
    const calls: string[] = [];
    const { deliver } = setup((e) => {
      calls.push(e.id);
      if (fail) throw new Error("database password is hunter2");
    });
    const req = signed();
    const r = await deliver(req);
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain("hunter2");
    expect(r.error).toContain("hunter2"); // available for server-side logs only
    fail = false;
    expect((await deliver(req)).status).toBe(200);
    expect(calls).toEqual(["evt_1", "evt_1"]);
    expect((await deliver(req)).body).toMatchObject({ status: "duplicate" });
  });

  it("an async rejection counts as a failure too", async () => {
    const { deliver } = setup(async () => {
      throw new Error("async boom");
    });
    expect((await deliver(signed())).status).toBe(500);
  });

  it("a worker that died mid-event is retried once its lock times out", async () => {
    let t = NOW_MS;
    const store = createMemoryStore({ now: () => t });
    const calls: string[] = [];
    const { deliver } = setup((e) => void calls.push(e.id), store);
    await store.begin("evt_1"); // another process claimed it and then died
    const req = signed();
    expect((await deliver(req, { lockTimeoutMs: 60_000 })).status).toBe(409);
    t += 60_001;
    expect((await deliver(req, { lockTimeoutMs: 60_000 })).status).toBe(200);
    expect(calls).toEqual(["evt_1"]);
  });

  it("if recording completion fails after the handler succeeded the answer is 500 (at-least-once)", async () => {
    const inner = createMemoryStore({ now: () => NOW_MS });
    const store: Store = { ...inner, complete: async () => { throw new Error("db down"); } };
    const { deliver } = setup(undefined, store);
    expect(await deliver(signed())).toMatchObject({ status: 500, body: { error: "store_error" } });
  });

  it("if the store is down before the handler: 500 and the handler does not run", async () => {
    const calls: string[] = [];
    const store: Store = { begin: async () => { throw new Error("db down"); }, complete: async () => {}, fail: async () => {} };
    const { deliver } = setup((e) => void calls.push(e.id), store);
    expect(await deliver(signed())).toMatchObject({ status: 500, body: { error: "store_error" } });
    expect(calls).toEqual([]);
  });
});

describe("payload validation (after the signature)", () => {
  it("validly signed non-JSON is 400 invalid_json", async () => {
    const { deliver } = setup();
    const body = "not json";
    const headers = { "stripe-signature": signStripePayload({ secret: SECRET, body, timestampSeconds: T0 + 10 }) };
    expect(await deliver({ body, headers })).toMatchObject({ status: 400, reason: "invalid_json" });
  });

  it("validly signed JSON that is not an event is 400 invalid_event", async () => {
    const { deliver } = setup();
    for (const body of ["[]", "{}", '{"id":"evt_1"}', serializeEvent({ id: "", type: "x", created: 1, data: { object: {} } })]) {
      const headers = { "stripe-signature": signStripePayload({ secret: SECRET, body, timestampSeconds: T0 + 10 }) };
      expect(await deliver({ body, headers })).toMatchObject({ status: 400, reason: "invalid_event" });
    }
  });
});
