import { describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db.ts";
import { ExportParseError, parseCsv, parseExport, type ExportRow } from "../src/export.ts";
import { applyEvent } from "../src/handlers.ts";
import type { StripeEvent } from "../src/events.ts";
import { exitCode, formatReport, reconcile, type FindingKind, type ReconcileResult } from "../src/reconcile.ts";
import { fixtureFiles, T0 } from "../testing/fixtures.ts";

/** A database as it looks after every fixture event was delivered. */
function seeded(): Db {
  const db = openDb();
  for (const f of fixtureFiles()) applyEvent(db, f.event as unknown as StripeEvent);
  return db;
}

const charge = (id: string, pi: string | null, amount: number, currency = "usd", extra: Record<string, unknown> = {}) =>
  ({ id, object: "charge", payment_intent: pi, amount, currency, status: "succeeded", amount_refunded: 0, ...extra });
const json = (...items: Array<Record<string, unknown>>) => JSON.stringify({ object: "list", data: items });
const run = (db: Db, text: string, opts: Parameters<typeof parseExport>[1] = {}, window: { from?: number; until?: number } = {}) =>
  reconcile({ rows: parseExport(text, opts).rows, db, ...window });
const kinds = (r: ReconcileResult): FindingKind[] => r.findings.map((f) => f.kind);

const CLEAN = json(
  charge("ch_fx_otp", "pi_fx_otp", 4900, "usd", { amount_refunded: 1500 }),
  charge("ch_fx_jpy", "pi_fx_jpy", 1500, "jpy"),
  charge("ch_fx_bob_1", "pi_fx_bob_1", 1200),
  charge("ch_fx_declined", "pi_fx_declined", 2500, "usd", { status: "failed" }),
);

describe("reconcile: a database and export that agree", () => {
  it("is clean and exits 0; failed charges are skipped, failed local payments are not expected", () => {
    const r = run(seeded(), CLEAN);
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(true);
    expect(exitCode(r)).toBe(0);
    expect(r.summary).toMatchObject({ stripeCharges: 3, localPayments: 3, matchedCharges: 3, skippedNotSucceeded: 1 });
    expect(formatReport(r)).toMatch(/RESULT: clean/);
  });

  it("matches on PaymentIntent when the local row has no charge id yet (JPY payment from checkout)", () => {
    const r = run(seeded(), json(charge("ch_fx_jpy", "pi_fx_jpy", 1500, "jpy")), {}, {});
    expect(kinds(r)).not.toContain("missing_in_db");
    expect(r.summary.matchedCharges).toBe(1);
  });
});

describe("reconcile: findings", () => {
  it("missing in the database", () => {
    const r = run(seeded(), json(charge("ch_new", "pi_new", 999)));
    expect(r.findings.find((f) => f.kind === "missing_in_db")).toMatchObject({ id: "ch_new", detail: expect.stringContaining("USD 9.99") });
    expect(exitCode(r)).toBe(1);
  });

  it("missing in Stripe: succeeded local payments absent from the export, but not failed ones", () => {
    const r = run(seeded(), json(charge("ch_fx_otp", "pi_fx_otp", 4900, "usd", { amount_refunded: 1500 })));
    const ids = r.findings.filter((f) => f.kind === "missing_in_stripe").map((f) => f.id).sort();
    expect(ids).toEqual(["ch_fx_bob_1", "pi_fx_jpy"]);
    expect(ids).not.toContain("pi_fx_declined");
    expect(ids).not.toContain("pi_fx_bob_2");
  });

  it("amount mismatch", () => {
    const r = run(seeded(), json(charge("ch_fx_bob_1", "pi_fx_bob_1", 1250)));
    const f = r.findings.find((x) => x.kind === "amount_mismatch");
    expect(f?.detail).toBe("Stripe USD 12.50, database USD 12.00 (difference USD 0.50)");
  });

  it("currency mismatch is reported instead of an amount mismatch", () => {
    const r = run(seeded(), json(charge("ch_fx_bob_1", "pi_fx_bob_1", 1200, "eur")));
    expect(kinds(r).filter((k) => k !== "missing_in_stripe")).toEqual(["currency_mismatch"]);
  });

  it("currency codes compare case-insensitively", () => {
    const r = run(seeded(), json(charge("ch_fx_bob_1", "pi_fx_bob_1", 1200, "USD")));
    expect(kinds(r)).not.toContain("currency_mismatch");
  });

  it("refund not recorded: Stripe has refunded more than the database knows", () => {
    const r = run(seeded(), json(charge("ch_fx_bob_1", "pi_fx_bob_1", 1200, "usd", { amount_refunded: 1200 })));
    expect(r.findings.find((f) => f.kind === "refund_not_recorded")?.detail).toBe("Stripe has USD 12.00 refunded, the database USD 0.00 (missing USD 12.00)");
  });

  it("refund total differs the other way: the database has more than Stripe", () => {
    const r = run(seeded(), json(charge("ch_fx_otp", "pi_fx_otp", 4900, "usd", { amount_refunded: 500 })));
    expect(kinds(r)).toContain("refund_amount_mismatch");
  });

  it("duplicate rows in the export are reported once and not counted twice", () => {
    const row = charge("ch_fx_bob_1", "pi_fx_bob_1", 1200);
    const r = run(seeded(), json(row, row));
    expect(kinds(r)).toContain("duplicate_in_export");
    expect(r.summary.stripeCharges).toBe(1);
  });

  it("the report lists every finding and exits 1", () => {
    const r = run(seeded(), json(charge("ch_fx_bob_1", "pi_fx_bob_1", 1250), charge("ch_new", "pi_new", 999)));
    const text = formatReport(r);
    expect(text).toMatch(/Missing in database \(Stripe has it\): 1/);
    expect(text).toMatch(/Missing in Stripe \(database has it\): 2/);
    expect(text).toMatch(/Amount mismatch: 1/);
    expect(text).toMatch(/RESULT: 4 discrepancies found/);
    expect(exitCode(r)).toBe(1);
  });
});

describe("reconcile: refunds as rows", () => {
  const refundRow = (id: string, amount: number, extra: Record<string, unknown> = {}) =>
    ({ id, object: "refund", amount, currency: "usd", status: "succeeded", charge: "ch_fx_otp", payment_intent: "pi_fx_otp", ...extra });

  it("a refund the database has, with the same amount, matches", () => {
    const r = run(seeded(), json(charge("ch_fx_otp", "pi_fx_otp", 4900, "usd", { amount_refunded: 1500 }), refundRow("re_fx_otp_1", 1500)));
    expect(r.findings.filter((f) => f.subject === "refund")).toEqual([]);
    expect(r.summary.matchedRefunds).toBe(1);
  });

  it("a refund Stripe has that the database lacks is 'not recorded'", () => {
    const r = run(seeded(), json(charge("ch_fx_otp", "pi_fx_otp", 4900, "usd", { amount_refunded: 1500 }), refundRow("re_fx_otp_1", 1500), refundRow("re_unknown", 2000)));
    expect(r.findings.filter((f) => f.kind === "refund_not_recorded").map((f) => f.id)).toEqual(["re_unknown"]);
  });

  it("a refund whose amount differs", () => {
    const r = run(seeded(), json(refundRow("re_fx_otp_1", 1400)));
    expect(kinds(r)).toContain("amount_mismatch");
  });

  it("a local refund absent from an export that has refund rows is missing in Stripe; absent from a charges-only export it is not flagged", () => {
    expect(kinds(run(seeded(), json(refundRow("re_other", 1))))).toContain("missing_in_stripe");
    const chargesOnly = run(seeded(), CLEAN);
    expect(chargesOnly.findings).toEqual([]);
  });

  it("an itemised refund missing locally is not flagged when the payment's refunded total already covers it", () => {
    const db = seeded();
    db.exec("DELETE FROM refunds"); // like an API version that only delivers the total
    const r = run(db, json(refundRow("re_fx_otp_1", 1500)));
    expect(kinds(r)).not.toContain("refund_not_recorded");
  });
});

describe("reconcile: balance-transaction exports", () => {
  const bt = (type: string, source: string, amount: number, currency = "usd") => ({ id: `txn_${source}`, object: "balance_transaction", type, source, amount, currency, fee: 0, net: amount, created: T0 });

  it("charges and refunds match by charge/refund id; payouts and fees are skipped", () => {
    const text = json(
      bt("charge", "ch_fx_otp", 4900), bt("charge", "ch_fx_bob_1", 1200), bt("refund", "re_fx_otp_1", -1500),
      bt("payout", "po_1", -5000), bt("stripe_fee", "fee_1", -30),
    );
    const parsed = parseExport(text);
    expect(parsed.skipped).toBe(2);
    const r = reconcile({ rows: parsed.rows, db: seeded() });
    expect(r.summary.matchedCharges).toBe(2);
    expect(r.summary.matchedRefunds).toBe(1);
    expect(kinds(r)).toEqual(["missing_in_stripe"]); // pi_fx_jpy was not in this export
  });

  it("known limit: a local payment that never saw its charge id cannot be matched from a balance-transaction export", () => {
    const r = reconcile({ rows: parseExport(json(bt("charge", "ch_fx_jpy", 1500, "jpy"))).rows, db: seeded() });
    expect(kinds(r)).toContain("missing_in_db"); // use a charges export (it carries payment_intent) for those
  });
});

describe("reconcile: zero-decimal currencies", () => {
  it("JSON minor units: JPY 1500 matches a database holding 1500", () => {
    expect(run(seeded(), json(charge("ch_fx_jpy", "pi_fx_jpy", 1500, "jpy"))).findings.filter((f) => f.kind !== "missing_in_stripe")).toEqual([]);
  });

  it("CSV major units: '1500' JPY is 1500 minor units, '49.00' USD is 4900", () => {
    const csv = "id,amount,currency,payment_intent\nch_fx_jpy,1500,JPY,pi_fx_jpy\nch_fx_otp,49.00,USD,pi_fx_otp\n";
    const rows = parseExport(csv).rows;
    expect(rows.map((r) => r.kind === "charge" && r.amount)).toEqual([1500, 4900]);
  });

  it("a x100 mistake on JPY shows up as an amount mismatch", () => {
    const r = run(seeded(), json(charge("ch_fx_jpy", "pi_fx_jpy", 150000, "jpy")));
    expect(r.findings.find((f) => f.kind === "amount_mismatch")?.detail).toBe("Stripe JPY 150000, database JPY 1500 (difference JPY 148500)");
  });

  it("a CSV that writes JPY with decimals is rejected, not rounded", () => {
    expect(() => parseExport("id,amount,currency\nch_1,15.50,JPY\n")).toThrow(/more decimal places/);
  });

  it("--minor-units reads CSV amounts as integers", () => {
    const rows = parseExport("id,amount,currency\nch_1,4900,usd\n", { minorUnits: true }).rows;
    expect(rows[0]).toMatchObject({ amount: 4900 });
    expect(() => parseExport("id,amount,currency\nch_1,49.00,usd\n", { minorUnits: true })).toThrow(ExportParseError);
  });
});

describe("reconcile: date window", () => {
  it("rows outside --from/--until are left out on both sides", () => {
    const db = seeded();
    // the export covers only the first minutes of January: later local payments must not be reported missing
    const text = json(charge("ch_fx_otp", "pi_fx_otp", 4900, "usd", { amount_refunded: 1500, created: T0 + 110 }));
    expect(kinds(run(db, text)).filter((k) => k === "missing_in_stripe").length).toBeGreaterThan(0);
    const windowed = run(db, text, {}, { from: T0, until: T0 + 150 });
    expect(windowed.findings).toEqual([]);
    expect(windowed.summary.outsideWindow).toBeGreaterThan(0);
  });
});

describe("export parsing", () => {
  it("reads a Dashboard-style CSV (headers with spaces, UTC times, 'Paid' status)", () => {
    const csv = "id,Created (UTC),Amount,Amount Refunded,Currency,Status,PaymentIntent ID\nch_a,2026-01-01 00:01:50,49.00,15.00,usd,Paid,pi_a\n";
    const [row] = parseExport(csv).rows;
    expect(row).toEqual({ kind: "charge", id: "ch_a", paymentIntent: "pi_a", amount: 4900, currency: "usd", status: "paid", amountRefunded: 1500, created: 1767225710 });
  });

  it("treats re_ ids and type=refund as refund rows", () => {
    const rows = parseExport("id,amount,currency,type\nre_1,5.00,usd,\nch_2,1.00,usd,refund\n").rows as ExportRow[];
    expect(rows.map((r) => r.kind)).toEqual(["refund", "refund"]);
  });

  it("parses RFC 4180 CSV: quotes, commas, newlines in fields, CRLF, BOM", () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n"line1\nline2",z\r\n')).toEqual([["a", "b"], ["x, y", 'say "hi"'], ["line1\nline2", "z"]]);
    expect(parseCsv("a,b\n\n1,2\n")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("reports where a bad file is bad", () => {
    expect(() => parseExport("id,amount\nch_1,1\n")).toThrow(/no "currency" column/);
    expect(() => parseExport("id,amount,currency\nch_1,abc,usd\n")).toThrow(/CSV line 2: amount: not a decimal/);
    expect(() => parseExport("id,amount,currency\nch_1,1,usd\nch_2,1\n")).toThrow(/CSV line 3: 2 fields/);
    expect(() => parseExport('id,amount,currency\n"ch_1,1,usd\n')).toThrow(/unterminated/);
    expect(() => parseExport("id,amount,currency\n,1,usd\n")).toThrow(/empty id/);
    expect(() => parseExport("id,amount,currency\nch_1,1,xx\n")).toThrow(/currency/);
    expect(() => parseExport("{not json")).toThrow(ExportParseError);
    expect(() => parseExport('{"data": 5}')).toThrow(/array/);
    expect(() => parseExport(json({ object: "customer", id: "cus_1" }))).toThrow(/unsupported object/);
    expect(() => parseExport(json(charge("ch_1", null, 12.5 as number)))).toThrow(/integer/);
  });

  it("accepts a bare JSON array as well as a Stripe list object", () => {
    expect(parseExport(JSON.stringify([charge("ch_1", "pi_1", 100)])).rows).toHaveLength(1);
  });
});
