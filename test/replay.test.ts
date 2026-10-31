import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db.ts";
import { createEventHandler } from "../src/handlers.ts";
import { createSqliteStore } from "../src/idempotency.ts";
import { collectFixtureFiles, DEMO_WEBHOOK_SECRET, replayFixtures } from "../src/replay.ts";
import { createWebhookServer } from "../src/server.ts";

const ROOT = join(import.meta.dirname, "..");
const TMP = join(ROOT, ".test-tmp");
mkdirSync(TMP, { recursive: true });
const scratch = mkdtempSync(join(TMP, "replay-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); })));
});

async function endpoint(): Promise<{ url: string; db: Db }> {
  const db = openDb();
  const server = createWebhookServer({ secret: DEMO_WEBHOOK_SECRET, store: createSqliteStore({ db }), handler: createEventHandler(db) });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhooks/stripe`, db };
}
const state = (db: Db) => ({
  subscriptions: db.prepare("SELECT id, status, canceled_at, current_period_end FROM subscriptions ORDER BY id").all(),
  payments: db.prepare("SELECT payment_intent_id, status, amount, currency, amount_refunded, charge_id FROM payments ORDER BY payment_intent_id").all(),
  orders: db.prepare("SELECT id, status, amount_total FROM orders ORDER BY id").all(),
  refunds: db.prepare("SELECT id, amount FROM refunds ORDER BY id").all(),
});

describe("collectFixtureFiles", () => {
  it("expands directories to sorted *.json files and keeps explicit files", () => {
    writeFileSync(join(scratch, "b.json"), "{}");
    writeFileSync(join(scratch, "a.json"), "{}");
    writeFileSync(join(scratch, "notes.txt"), "x");
    expect(collectFixtureFiles([scratch]).map((p) => p.slice(scratch.length + 1))).toEqual(["a.json", "b.json"]);
    expect(collectFixtureFiles([join(scratch, "notes.txt")])).toEqual([join(scratch, "notes.txt")]);
    expect(() => collectFixtureFiles([join(scratch, "missing")])).toThrow();
  });
});

describe("replayFixtures against a real endpoint", () => {
  const files = collectFixtureFiles([join(ROOT, "fixtures", "subscription")]);

  it("delivers a whole lifecycle; every event is acknowledged and the database ends canceled", async () => {
    const { url, db } = await endpoint();
    const results = await replayFixtures({ files, url, secret: DEMO_WEBHOOK_SECRET });
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(state(db).subscriptions).toMatchObject([{ id: "sub_fx_bob", status: "canceled" }]);
    expect(state(db).payments).toMatchObject([
      { payment_intent_id: "pi_fx_bob_1", status: "succeeded", amount: 1200 },
      { payment_intent_id: "pi_fx_bob_2", status: "failed" },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM processed_events WHERE status = 'done'").get()).toEqual({ n: 6 });
  });

  it("--twice: every second delivery is answered as a duplicate and changes nothing", async () => {
    const once = await endpoint();
    await replayFixtures({ files, url: once.url, secret: DEMO_WEBHOOK_SECRET });
    const twice = await endpoint();
    const results = await replayFixtures({ files, url: twice.url, secret: DEMO_WEBHOOK_SECRET, twice: true });
    expect(results.filter((r) => r.attempt === 2).map((r) => JSON.parse(r.body).status)).toEqual(Array(6).fill("duplicate"));
    expect(state(twice.db)).toEqual(state(once.db));
  });

  it("--reverse: delivering the lifecycle backwards ends in the same state as in order", async () => {
    const forward = await endpoint();
    await replayFixtures({ files, url: forward.url, secret: DEMO_WEBHOOK_SECRET });
    const backward = await endpoint();
    const results = await replayFixtures({ files, url: backward.url, secret: DEMO_WEBHOOK_SECRET, reverse: true });
    expect(results[0]?.file).toContain("06-customer.subscription.deleted");
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(state(backward.db)).toEqual(state(forward.db));
  });

  it("all fixture directories together produce the expected rows", async () => {
    const { url, db } = await endpoint();
    const all = collectFixtureFiles(["one-time-payment", "jpy-payment", "subscription", "payment-failed"].map((d) => join(ROOT, "fixtures", d)));
    await replayFixtures({ files: all, url, secret: DEMO_WEBHOOK_SECRET });
    expect(state(db).payments).toEqual([
      { payment_intent_id: "pi_fx_bob_1", status: "succeeded", amount: 1200, currency: "usd", amount_refunded: 0, charge_id: "ch_fx_bob_1" },
      { payment_intent_id: "pi_fx_bob_2", status: "failed", amount: 1200, currency: "usd", amount_refunded: 0, charge_id: null },
      { payment_intent_id: "pi_fx_declined", status: "failed", amount: 2500, currency: "usd", amount_refunded: 0, charge_id: null },
      { payment_intent_id: "pi_fx_jpy", status: "succeeded", amount: 1500, currency: "jpy", amount_refunded: 0, charge_id: null },
      { payment_intent_id: "pi_fx_otp", status: "partially_refunded", amount: 4900, currency: "usd", amount_refunded: 1500, charge_id: "ch_fx_otp" },
    ]);
    expect(state(db).refunds).toEqual([{ id: "re_fx_otp_1", amount: 1500 }]);
  });

  it("a wrong secret is rejected with 400 for every delivery and nothing is stored", async () => {
    const { url, db } = await endpoint();
    const results = await replayFixtures({ files, url, secret: "whsec_test_wrong_secret", twice: false });
    expect(results.every((r) => r.status === 400)).toBe(true);
    expect(state(db).subscriptions).toEqual([]);
  });
});
