import { isStripeEvent, type StripeEvent } from "./events.ts";
import type { Store } from "./idempotency.ts";
import { verifyStripeSignature, type VerifyFailure } from "./verify.ts";

export type HeadersLike = Headers | Record<string, string | string[] | undefined>;

export interface WebhookResult {
  /** HTTP status to send. */
  status: number;
  /** JSON body to send. Never contains secrets or error text. */
  body: Record<string, unknown>;
  /** Exact cause, for your logs only (not sent to the caller). */
  reason?: VerifyFailure | "body_not_raw" | "invalid_json" | "invalid_event";
  /** Handler or store error text, for your logs only. */
  error?: string;
}

export type EventHandler = (event: StripeEvent) => void | Promise<void>;

export interface WebhookParams {
  /** The body exactly as received (string, Buffer or Uint8Array). A parsed object is rejected. */
  rawBody: unknown;
  headers: HeadersLike;
  /** `whsec_...`, or two during a rolled-secret overlap. */
  secret: string | readonly string[];
  store: Store;
  handler: EventHandler;
  toleranceSeconds?: number;
  lockTimeoutMs?: number;
  /** Epoch milliseconds; injectable for tests. */
  nowMs?: number;
}

function headerValue(headers: HeadersLike, name: string): string | undefined {
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (key.toLowerCase() === wanted) return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

/**
 * Framework-agnostic Stripe webhook receiver. In order:
 *
 *  1. the body must be raw bytes/text (an already-parsed object can never verify)       -> 400
 *  2. verify `Stripe-Signature` over those bytes, then the timestamp window             -> 400
 *  3. parse the JSON (only after verification) and check it looks like an event         -> 400
 *  4. `store.begin(event.id)`: done -> 200 duplicate, in flight -> 409, otherwise run
 *  5. handler returns -> `complete`, 200. Handler throws -> `fail`, 500, so Stripe retries.
 *
 * 409 for an event another worker is still handling is deliberate: Stripe retries any non-2xx, so
 * the event is not lost if that worker dies, whereas a 200 here would end the retries.
 */
export async function handleStripeWebhook(params: WebhookParams): Promise<WebhookResult> {
  const { rawBody } = params;
  if (typeof rawBody !== "string" && !(rawBody instanceof Uint8Array)) {
    return { status: 400, body: { error: "invalid_request" }, reason: "body_not_raw" };
  }

  const verified = verifyStripeSignature({
    secret: params.secret,
    header: headerValue(params.headers, "stripe-signature"),
    body: rawBody,
    ...(params.toleranceSeconds === undefined ? {} : { toleranceSeconds: params.toleranceSeconds }),
    ...(params.nowMs === undefined ? {} : { nowMs: params.nowMs }),
  });
  if (!verified.ok) {
    // One body for every cause, so a forger learns nothing about which check failed.
    return { status: 400, body: { error: "invalid_signature" }, reason: verified.reason };
  }

  let event: unknown;
  try {
    event = JSON.parse(typeof rawBody === "string" ? rawBody : Buffer.from(rawBody).toString("utf8"));
  } catch {
    return { status: 400, body: { error: "invalid_json" }, reason: "invalid_json" };
  }
  if (!isStripeEvent(event)) {
    return { status: 400, body: { error: "invalid_event" }, reason: "invalid_event" };
  }

  let claim;
  try {
    claim = await params.store.begin(event.id, {
      type: event.type,
      ...(params.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: params.lockTimeoutMs }),
    });
  } catch (error) {
    return { status: 500, body: { error: "store_error" }, error: errorText(error) };
  }
  if (claim === "done") return { status: 200, body: { received: true, status: "duplicate" } };
  if (claim === "in_flight") return { status: 409, body: { received: false, status: "in_flight" } };

  try {
    await params.handler(event);
  } catch (error) {
    const text = errorText(error);
    try {
      await params.store.fail(event.id, text);
    } catch {
      // the lock will expire on its own; the 500 below is what makes Stripe retry
    }
    return { status: 500, body: { error: "handler_failed" }, error: text };
  }

  try {
    await params.store.complete(event.id);
  } catch (error) {
    // The handler succeeded but we could not record it: answer 500 so Stripe retries (at-least-once).
    return { status: 500, body: { error: "store_error" }, error: errorText(error) };
  }
  return { status: 200, body: { received: true, status: "ok" } };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
