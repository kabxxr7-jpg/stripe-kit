import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { isStripeEvent } from "../src/events.ts";
import { verifyStripeSignature } from "../src/verify.ts";
import { fixtureFiles, serializeEvent, signedRequest, TEST_WEBHOOK_SECRET } from "../testing/fixtures.ts";

const ROOT = join(import.meta.dirname, "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe("fixture files", () => {
  it("the committed files are exactly what the generator produces (run `npm run fixtures:generate` if this fails)", () => {
    const expected = fixtureFiles().map((f) => f.path).sort();
    const actual = walk(join(ROOT, "fixtures")).map((p) => relative(join(ROOT, "fixtures"), p)).sort();
    expect(actual).toEqual(expected);
    for (const f of fixtureFiles()) {
      expect(readFileSync(join(ROOT, "fixtures", f.path), "utf8"), f.path).toBe(serializeEvent(f.event) + "\n");
    }
  });

  it("every fixture is an event with a unique id, and verifies when signed", () => {
    const ids = new Set<string>();
    for (const f of fixtureFiles()) {
      expect(isStripeEvent(f.event), f.path).toBe(true);
      const id = (f.event as { id: string }).id;
      expect(ids.has(id), `duplicate id ${id}`).toBe(false);
      ids.add(id);
      const req = signedRequest(f.event);
      expect(verifyStripeSignature({ secret: TEST_WEBHOOK_SECRET, header: req.headers["stripe-signature"], body: req.body }).ok).toBe(true);
    }
  });

  it("fixture bodies are pretty-printed like Stripe's, so re-serialising them changes the bytes", () => {
    for (const f of fixtureFiles()) {
      const text = serializeEvent(f.event);
      expect(JSON.stringify(JSON.parse(text)), f.path).not.toBe(text);
    }
  });
});

describe("repository hygiene", () => {
  it("contains no real-looking Stripe keys or webhook secrets", () => {
    const patterns = [
      /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/, // real keys are one unbroken alphanumeric run
      /\bwhsec_[A-Za-z0-9+/=]{24,}/,
      /\b(?:sk|rk)_live_/i, // only the refusal tests and the docs may mention the prefix
    ];
    const allowedLive = new Set(["src/live-check.ts", "test/live-check.test.ts", "test/fixtures.test.ts", "test/e2e.test.ts", "README.md", "scripts/live-check.ts"]);
    const files = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "test")), ...walk(join(ROOT, "testing")), ...walk(join(ROOT, "scripts")),
      ...walk(join(ROOT, "fixtures")), ...walk(join(ROOT, "examples")), join(ROOT, "README.md")];
    for (const file of files) {
      const rel = relative(ROOT, file);
      const text = readFileSync(file, "utf8");
      for (const [i, pattern] of patterns.entries()) {
        if (i === 2 && allowedLive.has(rel)) continue;
        expect(pattern.test(text), `${rel} matches ${pattern}`).toBe(false);
      }
    }
  });
});
