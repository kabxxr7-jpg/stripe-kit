import type { Db } from "./db.ts";
import type { ExportCharge, ExportRefund, ExportRow } from "./export.ts";
import { formatMoney } from "./money.ts";

export type FindingKind =
  | "missing_in_db"
  | "missing_in_stripe"
  | "amount_mismatch"
  | "currency_mismatch"
  | "refund_not_recorded"
  | "refund_amount_mismatch"
  | "duplicate_in_export";

export interface Finding {
  kind: FindingKind;
  subject: "charge" | "refund";
  id: string;
  detail: string;
}

export interface ReconcileResult {
  ok: boolean;
  findings: Finding[];
  summary: {
    stripeCharges: number;
    stripeRefunds: number;
    localPayments: number;
    localRefunds: number;
    matchedCharges: number;
    matchedRefunds: number;
    /** Export charges that are not settled (failed, pending ...): not compared. */
    skippedNotSucceeded: number;
    /** Rows left out because of --from/--until. */
    outsideWindow: number;
  };
}

interface LocalPayment {
  payment_intent_id: string;
  charge_id: string | null;
  amount: number;
  currency: string;
  status: string;
  amount_refunded: number;
  paid_at: number | null;
}
interface LocalRefund {
  id: string;
  charge_id: string | null;
  payment_intent_id: string | null;
  amount: number;
  currency: string;
  created_at: number;
}

const SETTLED = new Set(["succeeded", "paid", "refunded", "partially_refunded", "partially refunded"]);
const isSettled = (status: string | null): boolean => status === null || SETTLED.has(status);

const KIND_ORDER: FindingKind[] = [
  "missing_in_db", "missing_in_stripe", "amount_mismatch", "currency_mismatch", "refund_not_recorded", "refund_amount_mismatch", "duplicate_in_export",
];

/**
 * Compares a Stripe-side export with the local database.
 *
 *  - Charges match on charge id, else on PaymentIntent id (a local row only knows its charge id once an
 *    event that carries it, such as invoice.paid or charge.refunded, was processed).
 *  - Only settled Stripe charges are expected locally; local payments in status `failed` are not
 *    expected in Stripe's successful charges.
 *  - Refunds are compared per charge as a total (`amount_refunded`) when the export has it, and per
 *    refund id when the export has refund rows.
 *  - `from`/`until` (epoch seconds) narrow BOTH sides by their creation time. Use them when the export
 *    covers only part of the database's history, otherwise every older local payment is reported as
 *    missing in Stripe.
 */
export function reconcile(input: {
  rows: readonly ExportRow[];
  db: Db;
  from?: number;
  until?: number;
}): ReconcileResult {
  const findings: Finding[] = [];
  const add = (kind: FindingKind, subject: Finding["subject"], id: string, detail: string) => findings.push({ kind, subject, id, detail });
  const inWindow = (t: number | null): boolean =>
    t === null || ((input.from === undefined || t >= input.from) && (input.until === undefined || t <= input.until));

  let outsideWindow = 0;
  let skippedNotSucceeded = 0;

  // ---- Stripe side
  const seen = new Set<string>();
  const charges: ExportCharge[] = [];
  const refunds: ExportRefund[] = [];
  for (const row of input.rows) {
    const key = `${row.kind}:${row.id}`;
    if (seen.has(key)) {
      add("duplicate_in_export", row.kind, row.id, "appears more than once in the export; the first row is used");
      continue;
    }
    seen.add(key);
    if (!inWindow(row.created)) {
      outsideWindow += 1;
      continue;
    }
    if (row.kind === "charge") {
      if (!isSettled(row.status)) {
        skippedNotSucceeded += 1;
        continue;
      }
      charges.push(row);
    } else {
      refunds.push(row);
    }
  }

  // ---- local side
  const payments = (input.db
    .prepare("SELECT payment_intent_id, charge_id, amount, currency, status, amount_refunded, paid_at FROM payments WHERE status != 'failed'")
    .all() as unknown as LocalPayment[]).filter((p) => {
    const ok = inWindow(p.paid_at);
    if (!ok) outsideWindow += 1;
    return ok;
  });
  const localRefunds = (input.db.prepare("SELECT id, charge_id, payment_intent_id, amount, currency, created_at FROM refunds").all() as unknown as LocalRefund[]).filter((r) => {
    const ok = inWindow(r.created_at);
    if (!ok) outsideWindow += 1;
    return ok;
  });
  const byCharge = new Map<string, LocalPayment>();
  const byIntent = new Map<string, LocalPayment>();
  for (const p of payments) {
    if (p.charge_id) byCharge.set(p.charge_id, p);
    byIntent.set(p.payment_intent_id, p);
  }
  const findPayment = (chargeId: string | null, intent: string | null): LocalPayment | undefined =>
    (chargeId ? byCharge.get(chargeId) : undefined) ?? (intent ? byIntent.get(intent) : undefined);

  // ---- charges
  const matchedPayments = new Set<string>();
  let matchedCharges = 0;
  for (const c of charges) {
    const local = findPayment(c.id, c.paymentIntent);
    if (!local) {
      add("missing_in_db", "charge", c.id, `Stripe has ${formatMoney(c.amount, c.currency)}${c.paymentIntent ? ` (${c.paymentIntent})` : ""}, the database has no such payment`);
      continue;
    }
    matchedPayments.add(local.payment_intent_id);
    matchedCharges += 1;
    if (local.currency !== c.currency) {
      add("currency_mismatch", "charge", c.id, `Stripe ${c.currency.toUpperCase()}, database ${local.currency.toUpperCase()}`);
    } else if (local.amount !== c.amount) {
      add("amount_mismatch", "charge", c.id, `Stripe ${formatMoney(c.amount, c.currency)}, database ${formatMoney(local.amount, local.currency)} (difference ${formatMoney(c.amount - local.amount, c.currency)})`);
    }
    if (c.amountRefunded !== null && local.currency === c.currency) {
      if (c.amountRefunded > local.amount_refunded) {
        add("refund_not_recorded", "charge", c.id, `Stripe has ${formatMoney(c.amountRefunded, c.currency)} refunded, the database ${formatMoney(local.amount_refunded, c.currency)} (missing ${formatMoney(c.amountRefunded - local.amount_refunded, c.currency)})`);
      } else if (c.amountRefunded < local.amount_refunded) {
        add("refund_amount_mismatch", "charge", c.id, `database has ${formatMoney(local.amount_refunded, c.currency)} refunded, Stripe only ${formatMoney(c.amountRefunded, c.currency)}`);
      }
    }
  }
  for (const p of payments) {
    if (!matchedPayments.has(p.payment_intent_id)) {
      add("missing_in_stripe", "charge", p.charge_id ?? p.payment_intent_id, `database has ${formatMoney(p.amount, p.currency)} (${p.payment_intent_id}, ${p.status}), the export has no matching charge`);
    }
  }

  // ---- refunds (only when the export has refund rows)
  const localRefundById = new Map(localRefunds.map((r) => [r.id, r]));
  const exportedRefundTotal = new Map<string, number>();
  for (const r of refunds) {
    const p = findPayment(r.chargeId, r.paymentIntent);
    if (p) exportedRefundTotal.set(p.payment_intent_id, (exportedRefundTotal.get(p.payment_intent_id) ?? 0) + r.amount);
  }
  let matchedRefunds = 0;
  for (const r of refunds) {
    const local = localRefundById.get(r.id);
    if (!local) {
      const p = findPayment(r.chargeId, r.paymentIntent);
      // Newer API versions deliver only the refunded total on the charge; that total counts as recorded.
      if (p && p.currency === r.currency && p.amount_refunded >= (exportedRefundTotal.get(p.payment_intent_id) ?? Infinity)) continue;
      add("refund_not_recorded", "refund", r.id, `Stripe has a refund of ${formatMoney(r.amount, r.currency)}, the database has no such refund`);
      continue;
    }
    matchedRefunds += 1;
    if (local.currency !== r.currency) add("currency_mismatch", "refund", r.id, `Stripe ${r.currency.toUpperCase()}, database ${local.currency.toUpperCase()}`);
    else if (local.amount !== r.amount) add("amount_mismatch", "refund", r.id, `Stripe ${formatMoney(r.amount, r.currency)}, database ${formatMoney(local.amount, local.currency)}`);
  }
  if (refunds.length > 0) {
    const exportedIds = new Set(refunds.map((r) => r.id));
    for (const r of localRefunds) {
      if (!exportedIds.has(r.id)) add("missing_in_stripe", "refund", r.id, `database has a refund of ${formatMoney(r.amount, r.currency)}, the export has no such refund`);
    }
  }

  findings.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.id.localeCompare(b.id));
  return {
    ok: findings.length === 0,
    findings,
    summary: {
      stripeCharges: charges.length,
      stripeRefunds: refunds.length,
      localPayments: payments.length,
      localRefunds: localRefunds.length,
      matchedCharges,
      matchedRefunds,
      skippedNotSucceeded,
      outsideWindow,
    },
  };
}

const TITLES: Record<FindingKind, string> = {
  missing_in_db: "Missing in database (Stripe has it)",
  missing_in_stripe: "Missing in Stripe (database has it)",
  amount_mismatch: "Amount mismatch",
  currency_mismatch: "Currency mismatch",
  refund_not_recorded: "Refund not recorded",
  refund_amount_mismatch: "Refunded total differs",
  duplicate_in_export: "Duplicate rows in the export",
};

export function formatReport(result: ReconcileResult): string {
  const s = result.summary;
  const lines = [
    "stripe-kit reconciliation report",
    "================================",
    `Stripe export : ${s.stripeCharges} charges, ${s.stripeRefunds} refunds (${s.skippedNotSucceeded} not succeeded and skipped)`,
    `Database      : ${s.localPayments} payments, ${s.localRefunds} refunds`,
    `Matched       : ${s.matchedCharges} charges, ${s.matchedRefunds} refunds` + (s.outsideWindow > 0 ? `   (${s.outsideWindow} rows outside the date window ignored)` : ""),
    "",
  ];
  for (const kind of KIND_ORDER) {
    const group = result.findings.filter((f) => f.kind === kind);
    if (group.length === 0) continue;
    lines.push(`${TITLES[kind]}: ${group.length}`);
    for (const f of group) lines.push(`  ${f.id}  ${f.detail}`);
    lines.push("");
  }
  lines.push(result.ok ? "RESULT: clean, no discrepancies" : `RESULT: ${result.findings.length} discrepanc${result.findings.length === 1 ? "y" : "ies"} found`);
  return lines.join("\n");
}

/** 0 = clean, 1 = discrepancies. (The CLI uses 2 for bad input.) */
export function exitCode(result: ReconcileResult): number {
  return result.ok ? 0 : 1;
}
