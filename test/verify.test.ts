import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signStripePayload, verifyStripeSignature } from "../src/verify.ts";

const SECRET = "whsec_test_unit_secret_not_real";
const NOW_S = 1_767_225_600;
const NOW_MS = NOW_S * 1000;
const BODY = JSON.stringify({ id: "evt_1", type: "x" }, null, 2);

const header = (body = BODY, secret = SECRET, t = NOW_S) => signStripePayload({ secret, body, timestampSeconds: t });
const verify = (h: string | undefined | null, body: string | Uint8Array = BODY, extra: Record<string, unknown> = {}) =>
  verifyStripeSignature({ secret: SECRET, header: h, body, nowMs: NOW_MS, ...extra });

describe("verifyStripeSignature", () => {
  it("accepts a correctly signed body (string and bytes)", () => {
    expect(verify(header())).toEqual({ ok: true, timestampSeconds: NOW_S });
    expect(verify(header(), Buffer.from(BODY)).ok).toBe(true);
  });

  it("matches a pinned vector computed independently of the implementation", () => {
    const expected = createHmac("sha256", SECRET).update(`${NOW_S}.${BODY}`).digest("hex");
    expect(header()).toBe(`t=${NOW_S},v1=${expected}`);
  });

  it("rejects a missing or empty header", () => {
    expect(verify(undefined)).toEqual({ ok: false, reason: "missing_header" });
    expect(verify(null)).toEqual({ ok: false, reason: "missing_header" });
    expect(verify("")).toEqual({ ok: false, reason: "missing_header" });
  });

  it("rejects malformed headers", () => {
    expect(verify("garbage")).toEqual({ ok: false, reason: "malformed_header" });
    expect(verify(`t=${NOW_S}`)).toEqual({ ok: false, reason: "malformed_header" }); // no v1
    expect(verify("v1=" + "a".repeat(64))).toEqual({ ok: false, reason: "malformed_header" }); // no t
    expect(verify(`t=${NOW_S},t=${NOW_S},v1=${"a".repeat(64)}`)).toEqual({ ok: false, reason: "malformed_header" }); // two t
    expect(verify(`t=abc,v1=${"a".repeat(64)}`)).toEqual({ ok: false, reason: "malformed_timestamp" });
  });

  it("rejects the wrong secret", () => {
    const h = header(BODY, "whsec_test_some_other_secret");
    expect(verify(h)).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("rejects a changed body, including a re-serialised one (the classic bug)", () => {
    const h = header();
    const reserialised = JSON.stringify(JSON.parse(BODY)); // same data, different bytes
    expect(reserialised).not.toBe(BODY);
    expect(verify(h, reserialised)).toEqual({ ok: false, reason: "signature_mismatch" });
    expect(verify(h, BODY + "\n")).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("treats the timestamp as part of the signed string", () => {
    const valid = header();
    const forged = valid.replace(`t=${NOW_S}`, `t=${NOW_S + 1}`);
    expect(verify(forged)).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("accepts any one matching v1 among several (secret roll)", () => {
    const oldSig = createHmac("sha256", "whsec_test_old_secret").update(`${NOW_S}.${BODY}`).digest("hex");
    const good = createHmac("sha256", SECRET).update(`${NOW_S}.${BODY}`).digest("hex");
    expect(verify(`t=${NOW_S},v1=${oldSig},v1=${good}`).ok).toBe(true);
    expect(verify(`t=${NOW_S},v1=${good},v1=${oldSig}`).ok).toBe(true); // order does not matter
    expect(verify(`t=${NOW_S},v1=${oldSig},v1=${"0".repeat(64)}`).ok).toBe(false);
  });

  it("accepts either of two endpoint secrets", () => {
    const old = "whsec_test_old_secret";
    const h = header(BODY, old);
    expect(verifyStripeSignature({ secret: [SECRET, old], header: h, body: BODY, nowMs: NOW_MS }).ok).toBe(true);
    expect(verifyStripeSignature({ secret: [SECRET], header: h, body: BODY, nowMs: NOW_MS }).ok).toBe(false);
  });

  it("ignores other schemes such as v0 (no downgrade)", () => {
    const v0 = createHmac("sha256", SECRET).update(`${NOW_S}.${BODY}`).digest("hex");
    expect(verify(`t=${NOW_S},v0=${v0}`)).toEqual({ ok: false, reason: "malformed_header" });
    expect(verify(`t=${NOW_S},v0=${v0},v1=${"0".repeat(64)}`)).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("ignores v1 values that are not 64 hex characters instead of throwing", () => {
    expect(verify(`t=${NOW_S},v1=short`)).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  describe("tolerance window", () => {
    it("accepts exactly at the tolerance and rejects one second past it", () => {
      expect(verify(header(BODY, SECRET, NOW_S - 300)).ok).toBe(true);
      expect(verify(header(BODY, SECRET, NOW_S - 301))).toEqual({ ok: false, reason: "timestamp_too_old" });
    });

    it("rejects timestamps too far in the future, accepts small skew", () => {
      expect(verify(header(BODY, SECRET, NOW_S + 30)).ok).toBe(true);
      expect(verify(header(BODY, SECRET, NOW_S + 301))).toEqual({ ok: false, reason: "timestamp_in_future" });
    });

    it("honours a custom tolerance", () => {
      const h = header(BODY, SECRET, NOW_S - 60);
      expect(verify(h, BODY, { toleranceSeconds: 120 }).ok).toBe(true);
      expect(verify(h, BODY, { toleranceSeconds: 30 })).toEqual({ ok: false, reason: "timestamp_too_old" });
    });

    it("checks the signature before the timestamp", () => {
      const stale = `t=${NOW_S - 99999},v1=${"0".repeat(64)}`;
      expect(verify(stale)).toEqual({ ok: false, reason: "signature_mismatch" });
    });

    it("refuses a zero or negative tolerance rather than disabling the check", () => {
      expect(() => verify(header(), BODY, { toleranceSeconds: 0 })).toThrow(RangeError);
      expect(() => verify(header(), BODY, { toleranceSeconds: -5 })).toThrow(RangeError);
    });
  });

  it("requires a non-empty secret", () => {
    expect(() => verifyStripeSignature({ secret: "", header: header(), body: BODY })).toThrow(TypeError);
    expect(() => verifyStripeSignature({ secret: [], header: header(), body: BODY })).toThrow(TypeError);
  });
});
