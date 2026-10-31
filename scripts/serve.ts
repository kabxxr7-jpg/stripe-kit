// Local webhook endpoint backed by SQLite.
//   STRIPE_WEBHOOK_SECRET=whsec_... npm run serve
//   npm run serve -- --demo            (uses the fictional fixture secret)
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openDb } from "../src/db.ts";
import { createEventHandler } from "../src/handlers.ts";
import { createSqliteStore } from "../src/idempotency.ts";
import { DEMO_WEBHOOK_SECRET } from "../src/replay.ts";
import { createWebhookServer } from "../src/server.ts";
import { parseArgs } from "./args.ts";

const { flags } = parseArgs(process.argv.slice(2), ["port", "db"]);
const secret = process.env["STRIPE_WEBHOOK_SECRET"] ?? (flags.has("demo") ? DEMO_WEBHOOK_SECRET : undefined);
if (!secret) {
  console.error("Set STRIPE_WEBHOOK_SECRET (whsec_...) or pass --demo to use the fictional fixture secret.");
  process.exit(2);
}
const port = Number(flags.get("port") ?? 4242);
const dbPath = String(flags.get("db") ?? "data/stripe-kit.db");
if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });

const db = openDb(dbPath);
const server = createWebhookServer({
  secret,
  store: createSqliteStore({ db }),
  handler: createEventHandler(db, {
    onOutcome: (event, outcome) => console.log(`  handled ${event.id} ${event.type}: ${outcome.result}${outcome.note ? ` (${outcome.note})` : ""}`),
  }),
  onResult: (r) => console.log(`${r.status} ${JSON.stringify(r.body)}${r.reason ? ` reason=${r.reason}` : ""}${r.error ? ` error=${r.error}` : ""}`),
});
server.listen(port, "127.0.0.1", () => {
  console.log(`listening on http://127.0.0.1:${port}/webhooks/stripe  (database: ${dbPath})${secret === DEMO_WEBHOOK_SECRET ? "  [demo secret]" : ""}`);
});
