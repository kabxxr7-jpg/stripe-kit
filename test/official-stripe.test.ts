import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { signStripePayload, verifyStripeSignature } from "../src/verify.ts";

/**
 * Cross-checks our verifier against the official `stripe` package (a dev dependency), offline.
 * This proves agreement with Stripe's own library code, not with Stripe's servers.
 */
const SECRET = "whsec_test_cross_check_not_real";
const NOW_S = 1_767_225_600;
const NOW_MS = NOW_S * 1000;
const PAYLOAD = JSON.stringify({ id: "evt_cross", object: "event", type: "invoice.paid", data: { object: { id: "in_1" } } }, null, 2);

function official(payload: string, header: string, secret = SECRET, tolerance = 300): boolean {
  try {
    Stripe.webhooks.constructEvent(payload, header, secret, tolerance, undefined, NOW_MS);
    return true;
  } catch {
    return false;
  }
}
const ours = (payload: string, header: string, secret = SECRET, toleranceSeconds = 300) =>
  verifyStripeSignature({ secret, header, body: payload, toleranceSeconds, nowMs: NOW_MS }).ok;

describe("agreement with the official stripe library", () => {
  it("our signer produces the header the official generator produces", () => {
    const theirs = Stripe.webhooks.generateTestHeaderString({ payload: PAYLOAD, secret: SECRET, timestamp: NOW_S });
    expect(signStripePayload({ secret: SECRET, body: PAYLOAD, timestampSeconds: NOW_S })).toBe(theirs);
  });

  it("we accept what the official generator signs, and the official verifier accepts our header", () => {
    const theirs = Stripe.webhooks.generateTestHeaderString({ payload: PAYLOAD, secret: SECRET, timestamp: NOW_S });
    expect(ours(PAYLOAD, theirs)).toBe(true);
    expect(official(PAYLOAD, theirs)).toBe(true);
    const mine = signStripePayload({ secret: SECRET, body: PAYLOAD, timestampSeconds: NOW_S });
    expect(official(PAYLOAD, mine)).toBe(true);
  });

  it("both reject the same bad inputs", () => {
    const good = Stripe.webhooks.generateTestHeaderString({ payload: PAYLOAD, secret: SECRET, timestamp: NOW_S });
    const old = Stripe.webhooks.generateTestHeaderString({ payload: PAYLOAD, secret: SECRET, timestamp: NOW_S - 301 });
    const wrongSecret = Stripe.webhooks.generateTestHeaderString({ payload: PAYLOAD, secret: "whsec_test_other", timestamp: NOW_S });
    const cases: Array<[string, string, string?]> = [
      ["tampered body", PAYLOAD + " ", good],
      ["re-serialised body", JSON.stringify(JSON.parse(PAYLOAD)), good],
      ["stale timestamp", PAYLOAD, old],
      ["wrong secret", PAYLOAD, wrongSecret],
      ["no v1", PAYLOAD, `t=${NOW_S}`],
    ];
    for (const [name, payload, header] of cases) {
      expect({ name, official: official(payload, header as string), ours: ours(payload, header as string) }).toEqual({ name, official: false, ours: false });
    }
  });

  it("both accept a multi-signature header where only one signature is valid", () => {
    const good = signStripePayload({ secret: SECRET, body: PAYLOAD, timestampSeconds: NOW_S }).split("v1=")[1] as string;
    const header = `t=${NOW_S},v1=${"0".repeat(64)},v1=${good}`;
    expect(official(PAYLOAD, header)).toBe(true);
    expect(ours(PAYLOAD, header)).toBe(true);
  });

  it("known difference: only we reject a timestamp from the future", () => {
    const future = Stripe.webhooks.generateTestHeaderString({ payload: PAYLOAD, secret: SECRET, timestamp: NOW_S + 3600 });
    expect(official(PAYLOAD, future)).toBe(true);
    expect(ours(PAYLOAD, future)).toBe(false);
  });
});
