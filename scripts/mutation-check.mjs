#!/usr/bin/env node
// Mutation check: applies one deliberate breakage at a time to a COPY of the project, runs the test
// suite, and reports whether any test noticed. A mutant that survives means the tests do not pin that
// behaviour down. The real src/ is never modified.
//
//   npm run mutation-check              run every mutant, exit 1 if any survives
//   npm run mutation-check -- --list    list the mutants
//   npm run mutation-check -- --only verify-skip-compare,webhook-drop-dedupe
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Each mutant: `find` (or each pair in `edits`) must occur exactly once in `file`; it is replaced by `replace`. */
const MUTANTS = [
  // --- signature verification
  { id: "verify-skip-compare", file: "src/verify.ts", what: "accept any signature (skip the constant-time compare)",
    find: "if (timingSafeEqual(expected, candidate)) matched = true;", replace: "if (timingSafeEqual(expected, candidate) || true) matched = true;" },
  { id: "verify-ignore-tolerance", file: "src/verify.ts", what: "ignore the tolerance window for old timestamps",
    find: 'if (ageSeconds > toleranceSeconds) return { ok: false, reason: "timestamp_too_old" };', replace: "" },
  { id: "verify-accept-future", file: "src/verify.ts", what: "accept timestamps from the future",
    find: 'if (-ageSeconds > toleranceSeconds) return { ok: false, reason: "timestamp_in_future" };', replace: "" },
  { id: "verify-first-v1-only", file: "src/verify.ts", what: "only look at the first v1 signature (breaks secret rolling)",
    find: 'if (/^[0-9a-fA-F]{64}$/.test(sig)) candidates.push(Buffer.from(sig, "hex"));', replace: 'if (/^[0-9a-fA-F]{64}$/.test(sig) && candidates.length === 0) candidates.push(Buffer.from(sig, "hex"));' },
  { id: "verify-timestamp-unsigned", file: "src/verify.ts", what: "leave the timestamp out of the signed string",
    find: 'const expected = createHmac("sha256", secret).update(t).update(".").update(params.body).digest();', replace: 'const expected = createHmac("sha256", secret).update(params.body).digest();' },
  { id: "verify-wide-default-tolerance", file: "src/verify.ts", what: "default tolerance 300 s becomes 3000 s",
    find: "export const DEFAULT_TOLERANCE_SECONDS = 300;", replace: "export const DEFAULT_TOLERANCE_SECONDS = 3000;" },
  // --- webhook receiver
  { id: "webhook-drop-dedupe", file: "src/webhook.ts", what: "run the handler again for an event that is already done",
    find: 'if (claim === "done") return { status: 200, body: { received: true, status: "duplicate" } };', replace: "" },
  { id: "webhook-duplicate-400", file: "src/webhook.ts", what: "answer a duplicate with 400 instead of 200",
    find: 'return { status: 200, body: { received: true, status: "duplicate" } };', replace: 'return { status: 400, body: { received: true, status: "duplicate" } };' },
  { id: "webhook-failure-200", file: "src/webhook.ts", what: "answer 200 when the handler threw (Stripe would not retry)",
    find: 'return { status: 500, body: { error: "handler_failed" }, error: text };', replace: 'return { status: 200, body: { error: "handler_failed" }, error: text };' },
  { id: "webhook-bad-signature-401", file: "src/webhook.ts", what: "answer a bad signature with 401 instead of 400",
    find: 'return { status: 400, body: { error: "invalid_signature" }, reason: verified.reason };', replace: 'return { status: 401, body: { error: "invalid_signature" }, reason: verified.reason };' },
  { id: "webhook-inflight-200", file: "src/webhook.ts", what: "answer 200 for an event another worker is still handling",
    find: 'return { status: 409, body: { received: false, status: "in_flight" } };', replace: 'return { status: 200, body: { received: false, status: "in_flight" } };' },
  { id: "webhook-keep-lock-on-failure", file: "src/webhook.ts", what: "do not release the lock when the handler fails (no retry)",
    find: "await params.store.fail(event.id, text);", replace: "" },
  { id: "webhook-verify-reserialised", file: "src/webhook.ts", what: "verify a re-serialised copy of the body instead of the raw one",
    find: "    body: rawBody,\n    ...(params.toleranceSeconds", replace: '    body: typeof rawBody === "string" ? JSON.stringify(JSON.parse(rawBody)) : rawBody,\n    ...(params.toleranceSeconds' },
  { id: "webhook-accept-parsed-body", file: "src/webhook.ts", what: "stop refusing a body that was already parsed",
    edits: [["const { rawBody } = params;", "const rawBody = params.rawBody as string;"], ['if (typeof rawBody !== "string" && !(rawBody instanceof Uint8Array)) {', "if (false) {"]] },
  // --- dedupe stores
  { id: "memory-failed-not-reclaimable", file: "src/idempotency.ts", what: "memory store: a failed event can never be claimed again",
    find: 'if (row.status === "failed" || now() - row.lockedAt > lockTimeoutMs) {', replace: "if (now() - row.lockedAt > lockTimeoutMs) {" },
  { id: "sqlite-no-stale-reclaim", file: "src/idempotency.ts", what: "sqlite store: a crashed worker's lock never expires",
    find: "(status = 'in_flight' AND locked_at < ?))", replace: "(status = 'in_flight' AND locked_at < ? AND 0))" },
  { id: "sqlite-done-is-inflight", file: "src/idempotency.ts", what: "sqlite store: a done event reports in_flight instead of done",
    find: 'return row?.status === "done" ? "done" : "in_flight";', replace: 'return row?.status === "never" ? "done" : "in_flight";' },
  // --- handlers / out-of-order safety
  { id: "sub-accept-stale-update", file: "src/handlers.ts", what: "apply a subscription update even if a newer one was already applied",
    find: "if (!deleted && event.created < row.last_event_created) {", replace: "if (false) {" },
  { id: "sub-canceled-not-terminal", file: "src/handlers.ts", what: "a canceled subscription can be revived by a later update",
    find: 'if (row.status === "canceled") return stale(`subscription ${id} is already canceled`);', replace: "" },
  { id: "payment-refund-overwrite", file: "src/handlers.ts", what: "an older charge snapshot can lower the refunded amount",
    find: "const refunded = Math.max(oldRefunded, u.amountRefunded);", replace: "const refunded = u.amountRefunded + 0 * oldRefunded;" },
  { id: "payment-failed-outranks-success", file: "src/handlers.ts", what: "a late failure can overwrite a successful payment",
    find: "{ failed: 1, succeeded: 2, partially_refunded: 3, refunded: 4 }", replace: "{ failed: 5, succeeded: 2, partially_refunded: 3, refunded: 4 }" },
  { id: "order-paid-can-regress", file: "src/handlers.ts", what: "a paid order can fall back to pending",
    find: "status = CASE WHEN orders.status = 'paid' THEN 'paid' ELSE excluded.status END,", replace: "status = excluded.status," },
  // --- money / reconciliation
  { id: "money-jpy-has-decimals", file: "src/money.ts", what: "treat JPY as a two-decimal currency",
    find: '"bif", "clp", "djf", "gnf", "jpy", "kmf",', replace: '"bif", "clp", "djf", "gnf", "kmf",' },
  { id: "reconcile-skip-currency", file: "src/reconcile.ts", what: "never report a currency mismatch",
    find: "if (local.currency !== c.currency) {\n      add(\"currency_mismatch\", \"charge\"", replace: "if (local.currency !== c.currency && c.currency === \"never\") {\n      add(\"currency_mismatch\", \"charge\"" },
  { id: "reconcile-skip-refund-check", file: "src/reconcile.ts", what: "never report a refund that is not recorded",
    find: "if (c.amountRefunded > local.amount_refunded) {", replace: "if (c.amountRefunded < 0) {" },
  { id: "reconcile-count-failed-charges", file: "src/reconcile.ts", what: "expect failed Stripe charges to exist locally",
    find: "if (!isSettled(row.status)) {", replace: "if (!isSettled(row.status) && row.id === \"\") {" },
  { id: "reconcile-exit-0", file: "src/reconcile.ts", what: "exit code 0 even when there are discrepancies",
    find: "return result.ok ? 0 : 1;", replace: "return result.ok ? 0 : 0;" },
  // --- API client, server, live-check
  { id: "api-no-idempotency-header", file: "src/stripe-api.ts", what: "send creates without an Idempotency-Key header",
    find: 'headers["idempotency-key"] = request.idempotencyKey ?? randomUUID();', replace: "void randomUUID();" },
  { id: "api-no-retries", file: "src/stripe-api.ts", what: "default to zero retries",
    find: "const maxRetries = client.maxRetries ?? 2;", replace: "const maxRetries = client.maxRetries ?? 0;" },
  { id: "server-no-body-limit", file: "src/server.ts", what: "effectively remove the request body size limit",
    find: "if (size > limit) {", replace: "if (size > limit * 1000) {" },
  { id: "livecheck-allow-live-key", file: "src/live-check.ts", what: "stop refusing live-mode keys explicitly",
    find: "if (/_live_/i.test(key)) {", replace: "if (false) {" },
  { id: "livecheck-no-redaction", file: "src/live-check.ts", what: "stop redacting the key from output",
    find: 'return key ? line.split(key).join("[redacted]") : line;', replace: "return line + (key ? \"\" : \"\");" },
];

const args = process.argv.slice(2);
if (args.includes("--list")) {
  for (const m of MUTANTS) console.log(`${m.id.padEnd(34)} ${m.file.padEnd(22)} ${m.what}`);
  process.exit(0);
}
const onlyArg = args.indexOf("--only");
const only = onlyArg >= 0 ? new Set((args[onlyArg + 1] ?? "").split(",")) : null;
const selected = only ? MUTANTS.filter((m) => only.has(m.id)) : MUTANTS;
if (selected.length === 0) {
  console.error("no mutants selected");
  process.exit(2);
}

// ---- work on a copy so the real tree is never touched
const WORK = join(ROOT, `.mutation-${process.pid}`);
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
for (const entry of ["src", "test", "testing", "scripts", "fixtures", "examples", "package.json", "tsconfig.json", "vitest.config.ts", "README.md"]) {
  cpSync(join(ROOT, entry), join(WORK, entry), { recursive: true });
}
symlinkSync(join(ROOT, "node_modules"), join(WORK, "node_modules"));
const cleanup = () => rmSync(WORK, { recursive: true, force: true });
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));

const bin = (name) => join(WORK, "node_modules", ".bin", name);
const cleanEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NODE_NO_WARNINGS: "1", CI: "1" };
const sh = (cmd, cmdArgs, timeout) => spawnSync(cmd, cmdArgs, { cwd: WORK, env: cleanEnv, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 });

function runTests() {
  const out = join(WORK, "result.json");
  rmSync(out, { force: true });
  const r = sh(bin("vitest"), ["run", "--bail", "1", "--reporter=json", `--outputFile=${out}`], 180_000);
  if (r.error?.code === "ETIMEDOUT") return { passed: false, why: "timeout (counted as detected)" };
  let failedTest = null;
  if (existsSync(out)) {
    try {
      const json = JSON.parse(readFileSync(out, "utf8"));
      for (const file of json.testResults) {
        const bad = file.assertionResults.find((a) => a.status === "failed");
        if (bad) {
          failedTest = `${file.name.split("/test/").pop()} > ${bad.fullName}`;
          break;
        }
      }
    } catch {
      /* fall through */
    }
  }
  return { passed: r.status === 0, why: failedTest ?? (r.status === 0 ? "" : "suite failed (see run output)") };
}

console.log("baseline: running the unmodified suite in the copy...");
const baseline = runTests();
if (!baseline.passed) {
  console.error("baseline suite does not pass; fix that before a mutation check is meaningful.");
  process.exit(2);
}

const results = [];
for (const m of selected) {
  const original = readFileSync(join(ROOT, m.file), "utf8");
  const edits = m.edits ?? [[m.find, m.replace]];
  let mutated = original;
  let stale = null;
  for (const [find, replace] of edits) {
    const occurrences = mutated.split(find).length - 1;
    if (occurrences !== 1) stale = `find-string occurs ${occurrences} times (must be exactly 1); the source changed`;
    mutated = mutated.replace(find, () => replace);
  }
  if (stale) {
    results.push({ ...m, status: "INVALID", why: stale });
    continue;
  }
  const target = join(WORK, m.file);
  writeFileSync(target, mutated);
  try {
    const tc = sh(bin("tsc"), ["--noEmit"], 120_000);
    if (tc.status !== 0) {
      results.push({ ...m, status: "INVALID", why: "mutant does not typecheck: " + (tc.stdout || tc.stderr).split("\n")[0] });
      continue;
    }
    const r = runTests();
    results.push({ ...m, status: r.passed ? "SURVIVED" : "KILLED", why: r.why });
  } finally {
    writeFileSync(target, original);
  }
  const last = results[results.length - 1];
  console.log(`${last.status.padEnd(9)} ${last.id}${last.status === "KILLED" ? `  <- ${last.why}` : ""}`);
}

const killed = results.filter((r) => r.status === "KILLED").length;
const survived = results.filter((r) => r.status === "SURVIVED");
const invalid = results.filter((r) => r.status === "INVALID");
const valid = results.length - invalid.length;
console.log("\nMutation check");
console.log("--------------");
console.log(`mutants run : ${results.length} (${invalid.length} invalid)`);
console.log(`killed      : ${killed}`);
console.log(`survived    : ${survived.length}`);
console.log(`kill rate   : ${valid === 0 ? "n/a" : `${((killed / valid) * 100).toFixed(1)}%`} (${killed}/${valid})`);
for (const s of survived) console.log(`  SURVIVED ${s.id}: ${s.what}  [${s.file}]`);
for (const s of invalid) console.log(`  INVALID  ${s.id}: ${s.why}`);
process.exit(survived.length > 0 || invalid.length > 0 ? 1 : 0);
