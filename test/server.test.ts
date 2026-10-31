import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryStore } from "../src/idempotency.ts";
import { createWebhookServer } from "../src/server.ts";
import { verifyStripeSignature } from "../src/verify.ts";
import { signedRequest, stripeEvent, TEST_WEBHOOK_SECRET as SECRET, T0 } from "../testing/fixtures.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); })));
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const event = (id = "evt_srv_1") => stripeEvent("invoice.paid", { id: "in_1", note: "Zoë ✨" }, { id, created: T0 });
const post = (url: string, req: { body: string | Buffer; headers: Record<string, string> }) => fetch(url, { method: "POST", headers: req.headers, body: req.body });

function start(options: Partial<Parameters<typeof createWebhookServer>[0]> = {}) {
  const calls: string[] = [];
  const server = createWebhookServer({
    secret: SECRET,
    store: createMemoryStore(),
    handler: (e) => void calls.push(e.id),
    ...options,
  });
  return { calls, base: listen(server) };
}

describe("node:http webhook server", () => {
  it("verifies the raw body over real HTTP and answers 200, then 200 duplicate", async () => {
    const { calls, base } = start();
    const url = `${await base}/webhooks/stripe`;
    const req = signedRequest(event());
    const first = await post(url, req);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ received: true, status: "ok" });
    const second = await post(url, req);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ received: true, status: "duplicate" });
    expect(calls).toEqual(["evt_srv_1"]);
  });

  it("returns 400 for a bad signature and for a tampered body, without running the handler", async () => {
    const { calls, base } = start();
    const url = `${await base}/webhooks/stripe`;
    expect((await post(url, signedRequest(event(), { secret: "whsec_test_wrong" }))).status).toBe(400);
    const good = signedRequest(event());
    expect((await post(url, { ...good, body: good.body.replace("in_1", "in_2") })).status).toBe(400);
    expect((await fetch(url, { method: "POST", body: good.body })).status).toBe(400); // no header at all
    expect(calls).toEqual([]);
  });

  it("rejects a stale signed request", async () => {
    const { calls, base } = start();
    const url = `${await base}/webhooks/stripe`;
    const stale = signedRequest(event(), { timestampSeconds: Math.floor(Date.now() / 1000) - 3600 });
    expect((await post(url, stale)).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("returns 500 when the handler throws, and the retry succeeds", async () => {
    let fail = true;
    const { calls, base } = start({ handler: (e) => { calls.push(e.id); if (fail) throw new Error("boom"); } });
    const url = `${await base}/webhooks/stripe`;
    const req = signedRequest(event());
    expect((await post(url, req)).status).toBe(500);
    fail = false;
    expect((await post(url, req)).status).toBe(200);
    expect(calls).toEqual(["evt_srv_1", "evt_srv_1"]);
  });

  it("two simultaneous deliveries of one event: one 200, one 409, handler once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { calls, base } = start({ handler: async (e) => { calls.push(e.id); await gate; } });
    const url = `${await base}/webhooks/stripe`;
    const req = signedRequest(event());
    const a = post(url, req);
    await new Promise((r) => setTimeout(r, 50));
    const b = await post(url, req);
    expect(b.status).toBe(409);
    release();
    expect((await a).status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("answers 404 for other paths, 405 for other methods, 413 for an oversized body, and has /health", async () => {
    const { base } = start({ maxBodyBytes: 200 });
    const root = await base;
    expect((await fetch(`${root}/nope`, { method: "POST", body: "{}" })).status).toBe(404);
    const get = await fetch(`${root}/webhooks/stripe`);
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    expect((await fetch(`${root}/health`)).status).toBe(200);
    const big = await fetch(`${root}/webhooks/stripe`, { method: "POST", body: "x".repeat(5000) });
    expect(big.status).toBe(413);
  });

  it("supports a custom path and reports each outcome to onResult", async () => {
    const seen: number[] = [];
    const { base } = start({ path: "/hooks/stripe", onResult: (r) => seen.push(r.status) });
    const root = await base;
    expect((await post(`${root}/webhooks/stripe`, signedRequest(event()))).status).toBe(404);
    expect((await post(`${root}/hooks/stripe`, signedRequest(event()))).status).toBe(200);
    expect(seen).toEqual([200]);
  });
});

describe("the classic bug, shown on a real server", () => {
  /** What many tutorials do: parse the JSON first, then "verify" the re-serialised object. */
  function naiveServer() {
    return createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const result = verifyStripeSignature({ secret: SECRET, header: req.headers["stripe-signature"] as string, body: JSON.stringify(parsed) });
        res.writeHead(result.ok ? 200 : 400).end();
      });
    });
  }

  it("a genuine, correctly signed event is rejected by a server that re-serialises, and accepted by ours", async () => {
    const req = signedRequest(event());
    const naive = await listen(naiveServer());
    expect((await post(naive, req)).status).toBe(400);

    const { base } = start();
    expect((await post(`${await base}/webhooks/stripe`, req)).status).toBe(200);
  });
});
