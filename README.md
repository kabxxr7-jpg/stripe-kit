# stripe-kit

> **Status:** a proof project. 196 tests pass locally on Node v25.2.1 (typecheck clean). Everything was tested against **signed fixture events and a local fake Stripe server**. It has **not** been run against Stripe's test mode yet, has not been used for any client, and has had no production use. See Limits below for what was not verified.

A tested starting point for the usual Stripe jobs: "my webhooks fail or fire twice", "orders and subscriptions drift out of sync with Stripe", "reconcile Stripe payouts against our database".

| Piece | File | What it does |
|---|---|---|
| Checkout Sessions | `src/stripe-api.ts` | Creates a one-time-payment or subscription Checkout Session with `fetch` against an injectable base URL. Sends an `Idempotency-Key` on every create, retries 5xx/429/409/network errors with the same key, validates amounts before any request |
| Signature check | `src/verify.ts` | The documented manual `Stripe-Signature` check over the raw body: several `v1` values, tolerance window both ways, constant-time compare, a reason for each rejection |
| Dedupe | `src/idempotency.ts` | Event-id store with `in_flight` / `done` / `failed` states: in-memory and `node:sqlite`. A failed or crashed event can be retried |
| Webhook handler | `src/webhook.ts` | `handleStripeWebhook(...)`: framework-agnostic. Verify, dedupe, run your handler, answer with the status code Stripe's retry logic needs |
| HTTP server | `src/server.ts` | A small `node:http` server around the handler (raw body, size limit, `/health`) |
| Event handlers | `src/handlers.ts` | `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`/`deleted`, `charge.refunded`, `payment_intent.payment_failed` into SQLite (`customers`, `orders`, `subscriptions`, `payments`, `refunds`, `processed_events` in `src/db.ts`). Safe against out-of-order delivery |
| Reconciliation | `src/export.ts`, `src/reconcile.ts` | Compares a Stripe-style export (JSON or CSV) with the local database and reports what is missing, mismatched or unrecorded. Integer minor units, zero-decimal currencies handled |
| Fakes and fixtures | `testing/` , `fixtures/` | A fake Stripe API server, a signed-event generator, and deterministic fixture files; `npm run replay` posts them to a running endpoint |
| Mutation check | `scripts/mutation-check.mjs` | Breaks `src/` in 32 deliberate ways, one at a time, and checks that the tests notice |
| Live check | `src/live-check.ts` | Optional test-mode smoke test; does nothing unless you set a test key |

Runtime code uses only Node built-ins (`node:crypto`, `node:http`, `node:sqlite`, global `fetch`). Dev dependencies: `vitest`, `typescript`, `@types/node`, and the official `stripe` package (used only in `test/official-stripe.test.ts` to cross-check the verifier). Nothing here is on npm; copy `src/` into a project or import it by path.

## Quickstart

```bash
npm ci
npm test                  # vitest run
npm run typecheck         # tsc --noEmit
npm run mutation-check    # about 30 s; exits 1 if any mutant survives
```

Run the whole flow locally, with the fictional demo secret (two terminals):

```bash
# terminal 1: webhook endpoint backed by data/stripe-kit.db
npm run serve -- --demo

# terminal 2: post signed fixtures (each file is signed with the current time, then POSTed)
npm run replay -- fixtures/subscription fixtures/one-time-payment fixtures/jpy-payment --demo
npm run replay -- fixtures/subscription --demo --twice     # the second delivery of each is answered "duplicate"
npm run replay -- fixtures/subscription --demo --reverse   # last to first; against a fresh database it ends in the same state (test/replay.test.ts)

# compare an export with the database (exit 0 clean, 1 discrepancies, 2 bad input)
npm run reconcile -- --export examples/charges-clean.json
npm run reconcile -- --export examples/charges-discrepancies.json
npm run reconcile -- --export examples/charges-clean.csv
```

With a real endpoint secret, set `STRIPE_WEBHOOK_SECRET=whsec_...` instead of `--demo` (`serve` refuses to start without one of the two). `npm run fixtures:generate` rewrites `fixtures/` (a test fails if the committed files drift from the generator).

`node:sqlite` is still flagged experimental in Node 25, so the scripts print one `ExperimentalWarning` line.

## What each piece does

### Checkout Sessions

```ts
import { createCheckoutSession } from "./src/index.ts";

const client = { apiKey: process.env.STRIPE_SECRET_KEY!, /* baseUrl defaults to https://api.stripe.com */ };

const { data: session, replayed } = await createCheckoutSession(client, {
  mode: "subscription",                       // or "payment"
  lineItems: [{ name: "Pro plan", unitAmount: 1200, currency: "usd", quantity: 1, recurring: { interval: "month" } }],
  successUrl: "https://example.com/ok?session={CHECKOUT_SESSION_ID}",
  cancelUrl: "https://example.com/cancel",
  clientReferenceId: "order-1001",
  idempotencyKey: "cart-42",                  // keep it stable per purchase: a double click returns the same session
});
```

Amounts are integer minor units (`1999` is USD 19.99, `1500` is JPY 1500) and a fractional amount is rejected before any request. Existing prices work too: `{ price: "price_...", quantity: 1 }`. `retrieveCheckoutSession` and `expireCheckoutSession` are included. Fulfil from the webhook, not from the success redirect.

### Webhook endpoint

```ts
import { handleStripeWebhook, createSqliteStore, createEventHandler, openDb } from "./src/index.ts";

const db = openDb("data/app.db");
const store = createSqliteStore({ db });
const handler = createEventHandler(db);

const result = await handleStripeWebhook({
  rawBody,                                    // exactly as received: string, Buffer or Uint8Array
  headers,                                    // Node req.headers, a plain object, or Headers
  secret: process.env.STRIPE_WEBHOOK_SECRET!, // or [newSecret, oldSecret] while rolling
  store, handler,
});
// send result.status and result.body; log result.reason / result.error yourself
```

| Situation | Status | Handler runs? |
|---|---|---|
| Body is not raw bytes/text (middleware already parsed it) | 400 | no |
| Header missing or malformed, wrong secret, body changed, timestamp too old or too far ahead | 400, one body for all causes | no |
| Signed but not JSON, or not event-shaped | 400 | no |
| First delivery of an event id | 200 | yes, once |
| Event id already handled | 200 `duplicate` | no |
| Same id currently being handled by another worker | 409 `in_flight` | no |
| Handler threw | 500 (no error text in the body); the id is released so the retry re-runs it | it ran |
| Store unreachable, or could not record completion | 500 | not run / ran |

`reason` (logs only) names the exact cause, for example `signature_mismatch` or `timestamp_too_old`. The 409 is deliberate: Stripe retries every non-2xx, so the event is not lost if the other worker dies; a 200 would end the retries.

`createWebhookServer({ secret, store, handler })` wraps this in a `node:http` server (default path `/webhooks/stripe`, 1 MiB body limit, `GET /health`). For Express, register `express.raw({ type: "application/json" })` on the webhook route and pass `req.body`; for a Next.js route handler use `await req.text()`. Neither framework snippet was run here; the raw-body wiring is exercised against `node:http` only.

### Handlers and out-of-order safety

Stripe does not guarantee delivery order. The handlers never let an older event undo a newer fact:

* **Subscriptions:** an update is applied only if its `event.created` is not older than the newest one applied. `canceled` is terminal, so a stale "active" update after the deletion is ignored. A deletion always applies. A `pending` stub left by `checkout.session.completed` is replaced by the first real subscription event. Tested over every delivery order of small event sets.
* **Payments** (keyed by PaymentIntent id): status only moves forward `failed < succeeded < partially_refunded < refunded`. A late failure cannot undo a success, a late `invoice.paid` cannot undo a refund, and the refunded amount is a high-water mark.
* **Orders:** `pending` becomes `paid`, never the reverse.
* Each event is applied in one transaction (a throw rolls back every write of that event) and applying the same event twice leaves the same rows, so correctness does not rest on the dedupe store alone.
* Events with equal `created` (one-second resolution) cannot be ordered; the last one delivered wins.

### Reconciliation

```bash
npm run reconcile -- --export export.json|export.csv [--db data/stripe-kit.db] [--minor-units] [--from 2026-01-01] [--until 2026-01-31] [--json]
```

Reports: **missing in database**, **missing in Stripe**, **amount mismatch**, **currency mismatch**, **refund not recorded** (Stripe has refunded more than the database knows), **refunded total differs**, and duplicate rows in the export. Exit code 0 clean, 1 discrepancies, 2 unreadable input. The database is opened read-only.

* JSON: a list of `charge`, `refund` or `balance_transaction` objects (an array or a Stripe `{ data: [...] }` list), amounts in integer minor units as the API returns them.
* CSV: decimal major units as in a Dashboard export (`49.00` USD, `1500` JPY); header names are matched loosely (`Amount Refunded`, `PaymentIntent ID`, `Created (UTC)`). Use `--minor-units` if your CSV already holds integers. More decimal places than the currency allows is an error, not a rounding.
* Charges match on charge id, else PaymentIntent id. Failed Stripe charges are skipped; failed local payments are not expected in Stripe's succeeded list.
* If the export covers only part of the database's history, pass `--from/--until`, otherwise every older local payment is reported as missing in Stripe.

### Mutation check

`npm run mutation-check` copies the project, applies one deliberate breakage at a time (skip the signature compare, ignore the tolerance, drop dedupe, 401 instead of 400, 200 on handler failure, drop the idempotency header, treat JPY as two-decimal, allow a live key in live-check, and so on), runs the suite, and reports the kill rate. `-- --list` shows all mutants. It never touches the real `src/`. A mutant the tests miss is a real gap in the tests; the first run found one (the live-key refusal was covered only by a second check behind it) and the test was tightened.

### Optional test-mode check

```bash
STRIPE_SECRET_KEY=sk_test_... npm run live-check
```

Does nothing (exit 0) unless `STRIPE_SECRET_KEY` is set, refuses `sk_live_` / `rk_live_` and anything that is not a test key (exit 2), and never prints the key (it is also redacted from any error text). With a test key it creates a one-time and a subscription Checkout Session, replays one create with the same idempotency key, reads one back, and expires both. **It has never been run against Stripe**; only against the local fake server in `test/live-check.test.ts`.

## Common Stripe webhook bugs this guards against

| Bug | What the kit does | Test |
|---|---|---|
| Verifying `JSON.stringify(req.body)` after `express.json()` | Verifies the raw bytes; refuses an already-parsed body | `webhook.test.ts`, `server.test.ts` (a naive server rejects a genuine event, this one accepts it) |
| Wrong secret (dashboard endpoint vs CLI `whsec_`, test vs live) | 400 with `signature_mismatch`; a failed attempt does not poison the event id | `webhook.test.ts` |
| Replayed or stale requests | Tolerance window both ways, checked after the signature | `verify.test.ts`, `webhook.test.ts` |
| Same event delivered twice (Stripe retries, at-least-once) | Dedupe by event id; second delivery is a 200 duplicate | `webhook.test.ts`, `replay.test.ts` |
| Duplicate while the first is still running | 409, handler runs once, retry works if the first fails | `webhook.test.ts`, `server.test.ts` |
| Handler fails but endpoint answers 200 (event lost) | 500, lock released, the retry re-runs the handler | `webhook.test.ts` |
| Worker dies mid-event | Lock expires after a timeout and the event is claimed again | `idempotency.test.ts` (including across two database connections) |
| Events arrive out of order | Subscriptions and payments never move backwards | `handlers.test.ts`, `replay.test.ts` (`--reverse`) |
| JPY or other zero-decimal amounts multiplied by 100 | Minor-unit helpers and checks; a x100 mistake shows up as a mismatch | `money.test.ts`, `reconcile.test.ts`, `checkout.test.ts` |
| Double click creates two Checkout Sessions | Idempotency key on creates, reused by retries | `checkout.test.ts` |
| Secret rolled in the dashboard | Accepts any matching `v1`, or an array of secrets | `verify.test.ts`, `webhook.test.ts` |

## Limits

* **Not run against Stripe.** No test-mode run, no live run. Fixture shapes are written from Stripe's public documentation, not captured from Stripe, and real events carry many more fields. Behaviour against the real service is unverified. `npm run live-check` exists so a test-mode run can be added.
* **The fake Stripe server is a test double.** It checks the request shape this kit sends and imitates the documented idempotency behaviour; it is not a model of Stripe's API.
* **API versions are not matrix-tested.** Fixtures follow the pre-2025 object shapes (`invoice.payment_intent`, a `refunds` list on charges, top-level `current_period_end`). Newer versions move or drop some of these: the handlers read the period end from `items` as a fallback, record only the refunded total when a charge has no `refunds` list, and **ignore an `invoice.paid` that has no `payment_intent`**. Legacy Charges-API charges without a PaymentIntent are ignored too.
* **Verifier differs from the official library in one way**: it also rejects a timestamp too far in the future (checked in `official-stripe.test.ts`). Constant-time comparison is by construction (`crypto.timingSafeEqual`), not measured.
* **Scope is small on purpose:** no PCI scope (card data never touches this code; use Checkout), no Connect, no tax, no coupons or promotion codes, no trials or proration logic, no customer portal, no disputes, no async-payment events (`checkout.session.async_payment_*`), no `payment_intent.succeeded` handler, no Stripe API pagination or export download (reconciliation reads files).
* **At-least-once, not exactly-once.** The lock is time-based and not fenced: a handler that runs longer than the lock timeout (5 minutes by default) can be re-run by a second worker. Handlers are idempotent upserts for that reason.
* **Equal-second events** cannot be ordered (see above). Same-id ordering relies on `event.created`.
* **Reconciliation matching:** a local payment learns its charge id only from events that carry it (`invoice.paid`, `charge.refunded`). A balance-transaction export identifies charges by charge id only, so payments that never saw one show as missing in the database; use a charges export (which carries `payment_intent`). Balance transactions in a settlement currency that differs from the charge currency are not converted. The CSV reader was tested against a layout modelled on Dashboard exports, not against real Dashboard files.
* **Storage:** SQLite via `node:sqlite` (experimental in Node 25), one file or `:memory:`. No Postgres dialect. Tested on Node v25.2.1 only. The in-memory store is single-process.
* **Server:** no TLS, rate limiting or IP allow-listing; Express and Next.js snippets above were not run.
* **The mutation check** shows that these 32 chosen breakages are detected, not that the tests catch every possible bug.
* Not covered: load, soak, security review, body-size or timing-attack tests beyond the above.

## Layout

```
src/            library code (money, verify, idempotency, db, webhook, server, handlers, stripe-api, export, reconcile, replay, live-check)
testing/        fake Stripe server and the fixture/signing generator (used by tests and scripts)
fixtures/       deterministic event files (unsigned; replay signs the exact bytes)
examples/       Stripe-style exports for the reconcile CLI
scripts/        serve, replay, reconcile, live-check, generate-fixtures, mutation-check
test/           vitest suites
```

MIT licensed. All data in fixtures and tests is fictional; the `whsec_test_...` and `sk_test_...` strings are obviously fake placeholders.
