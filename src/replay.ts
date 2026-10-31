import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { signStripePayload } from "./verify.ts";

/** Fictional secret for local demos and tests. Not a credential. */
export const DEMO_WEBHOOK_SECRET = "whsec_test_fixture_secret_not_real";

export interface ReplayResult {
  file: string;
  attempt: number;
  status: number;
  body: string;
}

/** Expands files and directories (non-recursive, `*.json`, sorted by name) into a flat list of files. */
export function collectFixtureFiles(paths: readonly string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    if (statSync(p).isDirectory()) {
      const entries = readdirSync(p, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) if (e.isFile() && e.name.endsWith(".json")) out.push(join(p, e.name));
    } else {
      out.push(p);
    }
  }
  return out;
}

/**
 * Signs each fixture file's exact bytes with the current time and POSTs it to `url`, the way Stripe
 * would. `twice` sends every file two times (the second should be answered as a duplicate);
 * `reverse` delivers the files last to first (out-of-order delivery).
 */
export async function replayFixtures(options: {
  files: readonly string[];
  url: string;
  secret: string | readonly string[];
  twice?: boolean;
  reverse?: boolean;
  fetch?: typeof fetch;
  nowSeconds?: () => number;
}): Promise<ReplayResult[]> {
  const doFetch = options.fetch ?? fetch;
  const now = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const files = options.reverse ? [...options.files].reverse() : [...options.files];
  const results: ReplayResult[] = [];
  for (const file of files) {
    const body = readFileSync(file);
    for (let attempt = 1; attempt <= (options.twice ? 2 : 1); attempt++) {
      const header = signStripePayload({ secret: options.secret, body, timestampSeconds: now() });
      const response = await doFetch(options.url, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8", "stripe-signature": header },
        body,
      });
      results.push({ file, attempt, status: response.status, body: await response.text() });
    }
  }
  return results;
}
