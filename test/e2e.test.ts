import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";

/**
 * The README quickstart, as processes: `serve` and `replay` and `reconcile` and `live-check` run as the npm
 * scripts run them (node scripts/*.ts), so argument parsing and exit codes are covered too.
 */
const run = promisify(execFile);
const ROOT = join(import.meta.dirname, "..");
const TMP = join(ROOT, ".test-tmp");
mkdirSync(TMP, { recursive: true });
const scratch = mkdtempSync(join(TMP, "e2e-"));
const children: ChildProcess[] = [];
afterAll(() => {
  for (const c of children) c.kill();
  rmSync(scratch, { recursive: true, force: true });
});

/** A child environment that cannot contain a Stripe key from the developer's shell. */
const cleanEnv = (extra: Record<string, string> = {}) => ({ PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", NODE_NO_WARNINGS: "1", ...extra });
const node = (args: string[], env = cleanEnv()) =>
  run(process.execPath, args, { cwd: ROOT, env }).then(
    (r) => ({ code: 0, out: r.stdout + r.stderr }),
    (e: { code?: number; stdout?: string; stderr?: string }) => ({ code: e.code ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") }),
  );

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

function startServe(port: number, db: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/serve.ts", "--demo", "--port", String(port), "--db", db], { cwd: ROOT, env: cleanEnv() });
    children.push(child);
    let out = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
      if (out.includes("listening")) resolve(child);
    });
    child.on("exit", (code) => reject(new Error(`serve exited early (${code}): ${out}`)));
    setTimeout(() => reject(new Error("serve did not start")), 10_000);
  });
}

describe("quickstart as processes", () => {
  it("serve + replay + reconcile: all fixtures in, a clean export reconciles, a bad one does not", async () => {
    const port = await freePort();
    const db = join(scratch, "quickstart.db");
    const server = await startServe(port, db);
    const url = `http://127.0.0.1:${port}/webhooks/stripe`;

    const replay = await node(["scripts/replay.ts", "fixtures/one-time-payment", "fixtures/jpy-payment", "fixtures/subscription", "fixtures/payment-failed", "--demo", "--url", url, "--twice"]);
    expect(replay.code).toBe(0);
    expect(replay.out).toMatch(/20 deliveries, all acknowledged/);
    expect(replay.out.match(/"status":"duplicate"/g)).toHaveLength(10);

    // stop the server so the WAL is checkpointed and the file is a plain database
    server.kill();
    await new Promise((r) => server.once("exit", r));

    const clean = await node(["scripts/reconcile.ts", "--export", "examples/charges-clean.json", "--db", db]);
    expect(clean.code).toBe(0);
    expect(clean.out).toMatch(/RESULT: clean/);

    const csv = await node(["scripts/reconcile.ts", "--export", "examples/charges-clean.csv", "--db", db]);
    expect(csv.code).toBe(0);

    const bad = await node(["scripts/reconcile.ts", "--export", "examples/charges-discrepancies.json", "--db", db]);
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/Missing in database[\s\S]*ch_fx_unrecorded/);
    expect(bad.out).toMatch(/Missing in Stripe[\s\S]*pi_fx_jpy/);
    expect(bad.out).toMatch(/Amount mismatch[\s\S]*USD 12.50, database USD 12.00/);
    expect(bad.out).toMatch(/Refund not recorded[\s\S]*USD 20.00 refunded, the database USD 15.00/);
    expect(bad.out).toMatch(/RESULT: 4 discrepancies found/);

    const json = await node(["scripts/reconcile.ts", "--export", "examples/charges-discrepancies.json", "--db", db, "--json"]);
    expect(JSON.parse(json.out).findings).toHaveLength(4);
  }, 30_000);

  it("reconcile exits 2 on bad input, never creating a database", async () => {
    expect((await node(["scripts/reconcile.ts"])).code).toBe(2);
    expect((await node(["scripts/reconcile.ts", "--export", "nope.json"])).code).toBe(2);
    expect((await node(["scripts/reconcile.ts", "--export", "examples/charges-clean.json", "--db", join(scratch, "missing.db")])).code).toBe(2);
    const badFile = join(scratch, "bad.csv");
    writeFileSync(badFile, "id,amount\nch_1,1\n");
    const db = join(scratch, "empty.db");
    openDb(db).close();
    const r = await node(["scripts/reconcile.ts", "--export", badFile, "--db", db]);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/no "currency" column/);
  });

  it("serve refuses to start without a secret; replay without arguments prints usage", async () => {
    const noSecret = await node(["scripts/serve.ts", "--db", ":memory:"]);
    expect(noSecret.code).toBe(2);
    expect(noSecret.out).toMatch(/STRIPE_WEBHOOK_SECRET/);
    const usage = await node(["scripts/replay.ts"]);
    expect(usage.code).toBe(2);
    expect(usage.out).toMatch(/usage/);
  });

  it("live-check does nothing without a key and refuses a live key, without printing it", async () => {
    const none = await node(["scripts/live-check.ts"]);
    expect(none.code).toBe(0);
    expect(none.out).toMatch(/skipped/);
    const live = "sk_live_not_a_real_key_0009";
    const refused = await node(["scripts/live-check.ts"], cleanEnv({ STRIPE_SECRET_KEY: live }));
    expect(refused.code).toBe(2);
    expect(refused.out).toMatch(/REFUSED/);
    expect(refused.out).not.toContain(live);
  });
});
