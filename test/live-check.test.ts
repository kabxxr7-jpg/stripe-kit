import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runLiveCheck } from "../src/live-check.ts";
import { startFakeStripe, type FakeStripe } from "../testing/fake-stripe.ts";

// Obviously fake values; the live-check is run only against the local fake server.
const FAKE_TEST_KEY = "sk_test_fake_key_for_local_server_only";
let fake: FakeStripe;
beforeAll(async () => { fake = await startFakeStripe({ apiKey: FAKE_TEST_KEY }); });
afterAll(() => fake.close());

async function run(env: Record<string, string | undefined>, extra: { baseUrl?: string; fetch?: typeof fetch } = {}) {
  const lines: string[] = [];
  const code = await runLiveCheck({ env, log: (l) => void lines.push(l), sleep: async () => {}, ...extra });
  return { code, lines, output: lines.join("\n") };
}

describe("live-check", () => {
  it("does nothing, and exits 0, when no key is set", async () => {
    const before = fake.requests.length;
    const r = await run({});
    expect(r.code).toBe(0);
    expect(r.output).toMatch(/skipped/);
    expect((await run({ STRIPE_SECRET_KEY: "" })).code).toBe(0);
    expect(fake.requests.length).toBe(before);
  });

  it("refuses live keys without making any request or printing the key", async () => {
    const calls: string[] = [];
    const spy = (async (url: string) => { calls.push(url); throw new Error("must not be called"); }) as unknown as typeof fetch;
    for (const key of ["sk_live_not_a_real_key_0001", "rk_live_not_a_real_key_0002", "SK_LIVE_not_a_real_key_0003"]) {
      const r = await run({ STRIPE_SECRET_KEY: key }, { fetch: spy });
      expect(r.code).toBe(2);
      expect(r.output).toMatch(/REFUSED/);
      expect(r.output).not.toContain(key);
    }
    expect(calls).toEqual([]);
  });

  it("refuses values that do not look like test keys", async () => {
    for (const key of ["pk_test_not_a_real_key_0004", "whsec_test_not_a_real_secret", "sk_test_", "hello world", "sk_test_abc"]) {
      const r = await run({ STRIPE_SECRET_KEY: key }, { baseUrl: fake.baseUrl });
      expect(r.code, key).toBe(2);
      expect(r.output).not.toContain(key);
    }
  });

  it("with a test key it creates, replays, reads and expires sessions, and never prints the key", async () => {
    const before = fake.requests.length;
    const r = await run({ STRIPE_SECRET_KEY: FAKE_TEST_KEY }, { baseUrl: fake.baseUrl });
    expect(r.code).toBe(0);
    expect(r.output).not.toContain(FAKE_TEST_KEY);
    expect(r.output).toMatch(/ok\s+create one-time payment session: cs_test_fake\d+/);
    expect(r.output).toMatch(/ok\s+create subscription session/);
    expect(r.output).toMatch(/same session cs_test_fake\d+, flagged as replayed/);
    expect(r.output).toMatch(/live-check passed/);
    const used = fake.requests.slice(before);
    expect(used.every((q) => q.headers.authorization === `Bearer ${FAKE_TEST_KEY}`)).toBe(true);
    const created = used.filter((q) => q.method === "POST" && q.path === "/v1/checkout/sessions");
    expect(created).toHaveLength(3); // payment, subscription, replay of the payment
    expect(created[0]?.headers["idempotency-key"]).toBe(created[2]?.headers["idempotency-key"]);
    expect(used.filter((q) => q.path.endsWith("/expire"))).toHaveLength(2);
    expect([...fake.sessions.values()].slice(-2).every((s) => s["status"] === "expired")).toBe(true);
  });

  it("a failing API reports the failure, exits 1 and still hides the key", async () => {
    // A well-formed test key that the fake server does not accept: every call answers 401.
    const wrongKey = "sk_test_a_key_the_server_rejects_1234";
    const r = await run({ STRIPE_SECRET_KEY: wrongKey }, { baseUrl: fake.baseUrl });
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/FAIL\s+create one-time payment session: HTTP 401 api_key_invalid/);
    expect(r.output).toMatch(/live-check FAILED/);
    expect(r.output).not.toContain(wrongKey);
  });

  it("redacts the key even if an error message echoes it", async () => {
    const key = "sk_test_echoed_key_value_1234567890";
    const echo = (async () => new Response(JSON.stringify({ error: { type: "invalid_request_error", message: `bad key ${key}` } }), { status: 400 })) as unknown as typeof fetch;
    const r = await run({ STRIPE_SECRET_KEY: key }, { fetch: echo });
    expect(r.code).toBe(1);
    expect(r.output).toContain("[redacted]");
    expect(r.output).not.toContain(key);
  });
});
