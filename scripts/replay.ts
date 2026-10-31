// Posts signed fixtures to a running endpoint.
//   npm run replay -- fixtures/subscription --demo
//   npm run replay -- fixtures/subscription --demo --twice      (second delivery must be a duplicate)
//   npm run replay -- fixtures/subscription --demo --reverse    (out-of-order delivery)
import { collectFixtureFiles, DEMO_WEBHOOK_SECRET, replayFixtures } from "../src/replay.ts";
import { parseArgs } from "./args.ts";

const { flags, positional } = parseArgs(process.argv.slice(2), ["url", "secret"]);
const secret = String(flags.get("secret") ?? process.env["STRIPE_WEBHOOK_SECRET"] ?? (flags.has("demo") ? DEMO_WEBHOOK_SECRET : ""));
if (positional.length === 0 || !secret) {
  console.error("usage: npm run replay -- <file|dir>... [--url http://127.0.0.1:4242/webhooks/stripe] [--demo | --secret whsec_...] [--twice] [--reverse]");
  console.error("the secret may also come from STRIPE_WEBHOOK_SECRET");
  process.exit(2);
}

let files: string[];
try {
  files = collectFixtureFiles(positional);
} catch (error) {
  console.error(`cannot read fixtures: ${(error as Error).message}`);
  process.exit(2);
}
const url = String(flags.get("url") ?? "http://127.0.0.1:4242/webhooks/stripe");
let results;
try {
  results = await replayFixtures({ files, url, secret, twice: flags.has("twice"), reverse: flags.has("reverse") });
} catch (error) {
  console.error(`request to ${url} failed: ${(error as Error).message}`);
  process.exit(1);
}
let bad = 0;
for (const r of results) {
  if (r.status < 200 || r.status >= 300) bad += 1;
  console.log(`${r.status}  ${r.file}${r.attempt > 1 ? ` (delivery ${r.attempt})` : ""}  ${r.body}`);
}
console.log(bad === 0 ? `${results.length} deliveries, all acknowledged` : `${bad} of ${results.length} deliveries were not acknowledged`);
process.exitCode = bad === 0 ? 0 : 1;
