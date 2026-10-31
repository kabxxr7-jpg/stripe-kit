import { createHmac, timingSafeEqual } from "node:crypto";

/** A request body exactly as received. Never a re-serialised object: the signature covers the bytes. */
export type Body = string | Uint8Array;

export const DEFAULT_TOLERANCE_SECONDS = 300;

export type VerifyFailure =
  | "missing_header"
  | "malformed_header"
  | "malformed_timestamp"
  | "signature_mismatch"
  | "timestamp_too_old"
  | "timestamp_in_future";

export type VerifyResult = { ok: true; timestampSeconds: number } | { ok: false; reason: VerifyFailure };

/**
 * Verifies a `Stripe-Signature` header by the manual algorithm in Stripe's docs:
 * https://docs.stripe.com/webhooks#verify-manually
 *
 *  1. Split the header on `,`, then each element on `=`: `t` is the timestamp (seconds), `v1` the
 *     signature(s). Other schemes (such as the test-only `v0`) are ignored, so there is no
 *     downgrade to a weaker scheme.
 *  2. signed_payload = `${t}.${rawBody}`
 *  3. expected = HMAC-SHA256(key = the endpoint's `whsec_...` secret, message = signed_payload), hex
 *  4. Compare to every `v1` in constant time; only then check |now - t| against the tolerance.
 *
 * Differences from Stripe's official library: a timestamp further in the future than the tolerance is
 * rejected too (the official one only rejects old ones), and the tolerance must be positive (the
 * official one treats 0 as "do not check").
 *
 * `body` must be the raw request body: any re-serialisation breaks the signature.
 */
export function verifyStripeSignature(params: {
  /** The `whsec_...` endpoint secret, or two during a "roll secret" overlap. Used as-is (UTF-8 bytes). */
  secret: string | readonly string[];
  /** Value of the `Stripe-Signature` header. */
  header: string | null | undefined;
  body: Body;
  /** Seconds; default 300. Must be positive. */
  toleranceSeconds?: number;
  /** Epoch milliseconds; injectable for tests. */
  nowMs?: number;
}): VerifyResult {
  const secrets = typeof params.secret === "string" ? [params.secret] : [...params.secret];
  if (secrets.length === 0) throw new TypeError("at least one webhook secret is required");
  for (const s of secrets) {
    if (typeof s !== "string" || s.length === 0) throw new TypeError("webhook secret must be a non-empty string");
  }
  const toleranceSeconds = params.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (!Number.isFinite(toleranceSeconds) || toleranceSeconds <= 0) {
    throw new RangeError("tolerance must be a positive number of seconds; 0 would disable the replay window");
  }

  if (!params.header) return { ok: false, reason: "missing_header" };

  let t: string | undefined;
  let tCount = 0;
  const v1: string[] = [];
  for (const element of params.header.split(",")) {
    const eq = element.indexOf("=");
    if (eq < 0) return { ok: false, reason: "malformed_header" };
    const prefix = element.slice(0, eq).trim();
    const value = element.slice(eq + 1).trim();
    if (prefix === "t") {
      tCount += 1;
      t = value;
    } else if (prefix === "v1") {
      v1.push(value);
    }
    // every other scheme is discarded on purpose
  }
  if (tCount !== 1 || t === undefined || v1.length === 0) return { ok: false, reason: "malformed_header" };
  if (!/^\d{1,15}$/.test(t)) return { ok: false, reason: "malformed_timestamp" };
  const timestampSeconds = Number(t);

  const candidates: Buffer[] = [];
  for (const sig of v1) {
    if (/^[0-9a-fA-F]{64}$/.test(sig)) candidates.push(Buffer.from(sig, "hex"));
  }

  // Compare against every secret x candidate without an early exit.
  let matched = false;
  for (const secret of secrets) {
    const expected = createHmac("sha256", secret).update(t).update(".").update(params.body).digest();
    for (const candidate of candidates) {
      if (timingSafeEqual(expected, candidate)) matched = true;
    }
  }
  if (!matched) return { ok: false, reason: "signature_mismatch" };

  const ageSeconds = (params.nowMs ?? Date.now()) / 1000 - timestampSeconds;
  if (ageSeconds > toleranceSeconds) return { ok: false, reason: "timestamp_too_old" };
  if (-ageSeconds > toleranceSeconds) return { ok: false, reason: "timestamp_in_future" };
  return { ok: true, timestampSeconds };
}

/** Builds a header the way Stripe does: `t=<ts>,v1=<hex>` (one `v1` per secret in use). */
export function signStripePayload(params: {
  secret: string | readonly string[];
  body: Body;
  timestampSeconds: number;
}): string {
  const secrets = typeof params.secret === "string" ? [params.secret] : [...params.secret];
  const t = String(params.timestampSeconds);
  const sigs = secrets.map((s) => createHmac("sha256", s).update(t).update(".").update(params.body).digest("hex"));
  return `t=${t},${sigs.map((s) => `v1=${s}`).join(",")}`;
}
