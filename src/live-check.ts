import { randomUUID } from "node:crypto";
import {
  createCheckoutSession, expireCheckoutSession, retrieveCheckoutSession, StripeApiError, type StripeClientOptions,
} from "./stripe-api.ts";

/**
 * Optional smoke test against Stripe's TEST mode. It does nothing unless STRIPE_SECRET_KEY is set,
 * refuses anything that is not a test-mode key, and never prints the key. It creates two Checkout
 * Sessions (one-time, subscription), replays one create with the same idempotency key, reads one back
 * and expires both, so nothing payable is left behind. No money moves in test mode; the sessions
 * are never opened.
 */
export async function runLiveCheck(options: {
  env: Record<string, string | undefined>;
  log: (line: string) => void;
  /** Tests only: point at the local fake server. The script itself never reads this from the environment. */
  baseUrl?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}): Promise<number> {
  const key = options.env["STRIPE_SECRET_KEY"];
  const log = (line: string) => options.log(redact(line, key));

  if (key === undefined || key === "") {
    log("live-check skipped: STRIPE_SECRET_KEY is not set (set a test-mode key, sk_test_..., to run it).");
    return 0;
  }
  if (/_live_/i.test(key)) {
    log("live-check REFUSED: that is a live-mode key. Only test-mode keys (sk_test_... or rk_test_...) are accepted.");
    return 2;
  }
  if (!/^(sk|rk)_test_[A-Za-z0-9_]{8,}$/.test(key)) {
    log("live-check REFUSED: STRIPE_SECRET_KEY does not look like a test-mode key (expected sk_test_... or rk_test_...).");
    return 2;
  }

  const client: StripeClientOptions = {
    apiKey: key,
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  };
  const urls = { successUrl: "https://example.com/success?session={CHECKOUT_SESSION_ID}", cancelUrl: "https://example.com/cancel" };
  const run = randomUUID();
  const created: string[] = [];
  let failed = false;

  const step = async (name: string, fn: () => Promise<string>): Promise<void> => {
    try {
      log(`ok    ${name}: ${await fn()}`);
    } catch (error) {
      failed = true;
      if (error instanceof StripeApiError) {
        log(`FAIL  ${name}: HTTP ${error.status}${error.code ? ` ${error.code}` : ""}: ${error.message}`);
      } else {
        log(`FAIL  ${name}: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }
  };

  log("live-check: test-mode key accepted (not printed). Creating sessions...");
  let paymentId = "";
  await step("create one-time payment session", async () => {
    const { data } = await createCheckoutSession(client, {
      mode: "payment", ...urls, idempotencyKey: `stripe-kit-check-${run}-payment`,
      lineItems: [{ name: "stripe-kit live-check item", unitAmount: 2000, currency: "usd", quantity: 1 }],
      clientReferenceId: `stripe-kit-check-${run.slice(0, 8)}`,
    });
    paymentId = data.id;
    created.push(data.id);
    return `${data.id} (${data.amount_total} ${data.currency})`;
  });
  await step("create subscription session", async () => {
    const { data } = await createCheckoutSession(client, {
      mode: "subscription", ...urls, idempotencyKey: `stripe-kit-check-${run}-subscription`,
      lineItems: [{ name: "stripe-kit live-check plan", unitAmount: 1200, currency: "usd", quantity: 1, recurring: { interval: "month" } }],
    });
    created.push(data.id);
    return `${data.id} (${data.amount_total} ${data.currency})`;
  });
  if (paymentId) {
    await step("replay the first create with the same idempotency key", async () => {
      const { data, replayed } = await createCheckoutSession(client, {
        mode: "payment", ...urls, idempotencyKey: `stripe-kit-check-${run}-payment`,
        lineItems: [{ name: "stripe-kit live-check item", unitAmount: 2000, currency: "usd", quantity: 1 }],
        clientReferenceId: `stripe-kit-check-${run.slice(0, 8)}`,
      });
      if (data.id !== paymentId) throw new Error(`replay returned a different session (${data.id})`);
      return `same session ${data.id}${replayed ? ", flagged as replayed" : ", NOT flagged as replayed"}`;
    });
    await step("retrieve the session", async () => {
      const s = await retrieveCheckoutSession(client, paymentId);
      return `${s.id} status=${s.status}`;
    });
  }
  for (const id of created) {
    await step(`expire ${id}`, async () => `status=${(await expireCheckoutSession(client, id)).status}`);
  }

  log(failed ? "live-check FAILED" : "live-check passed (test mode)");
  return failed ? 1 : 0;
}

function redact(line: string, key: string | undefined): string {
  return key ? line.split(key).join("[redacted]") : line;
}
