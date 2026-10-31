import { assertMinorUnits, majorToMinor, normalizeCurrency } from "./money.ts";

/** One row of a Stripe-side export, normalised. Amounts are integer minor units. */
export interface ExportCharge {
  kind: "charge";
  id: string;
  paymentIntent: string | null;
  amount: number;
  currency: string;
  /** Lower-case status as exported, or null when the source has none (balance transactions). */
  status: string | null;
  /** Null when the export does not say (balance transactions). */
  amountRefunded: number | null;
  /** Epoch seconds, or null. */
  created: number | null;
}
export interface ExportRefund {
  kind: "refund";
  id: string;
  chargeId: string | null;
  paymentIntent: string | null;
  amount: number;
  currency: string;
  status: string | null;
  created: number | null;
}
export type ExportRow = ExportCharge | ExportRefund;

export interface ParsedExport {
  rows: ExportRow[];
  /** Rows that were read but are not charges or refunds (payouts, fees, adjustments ...). */
  skipped: number;
}

export class ExportParseError extends Error {}

// ---- CSV -----------------------------------------------------------------------------------------

/** RFC 4180: quoted fields, doubled quotes, commas and newlines inside quotes, CRLF or LF, optional BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < text.length; i++) {
    const c = text[i] as string;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      if (field !== "") throw new ExportParseError("CSV: a quote in the middle of an unquoted field");
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (inQuotes) throw new ExportParseError("CSV: unterminated quoted field");
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const HEADER_ALIASES: Record<string, string> = {
  id: "id", chargeid: "id",
  amount: "amount",
  currency: "currency",
  amountrefunded: "amountRefunded",
  status: "status",
  paymentintent: "paymentIntent", paymentintentid: "paymentIntent",
  type: "type",
  created: "created", createdutc: "created", createddate: "created", createdate: "created",
  charge: "charge", chargeidforrefund: "charge",
};

function parseCreated(value: string, where: string): number | null {
  const v = value.trim();
  if (v === "") return null;
  if (/^\d{9,11}$/.test(v)) return Number(v);
  // Dashboard exports use "2026-01-01 00:00:00" in UTC.
  const iso = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(v) ? `${v.replace(" ", "T")}${v.length === 16 ? ":00" : ""}Z` : v;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new ExportParseError(`${where}: cannot read the created time ${JSON.stringify(value)}`);
  return Math.floor(ms / 1000);
}

function parseCsvExport(text: string, minorUnits: boolean): ParsedExport {
  const table = parseCsv(text);
  const header = table[0];
  if (!header) throw new ExportParseError("CSV: empty file");
  const columns = new Map<string, number>();
  header.forEach((h, i) => {
    const key = HEADER_ALIASES[h.toLowerCase().replace(/[^a-z0-9]/g, "")];
    if (key && !columns.has(key)) columns.set(key, i);
  });
  for (const need of ["id", "amount", "currency"]) {
    if (!columns.has(need)) throw new ExportParseError(`CSV: no "${need}" column (found: ${header.join(", ")})`);
  }
  const rows: ExportRow[] = [];
  for (let r = 1; r < table.length; r++) {
    const cells = table[r] as string[];
    const where = `CSV line ${r + 1}`;
    const cell = (name: string): string => (cells[columns.get(name) ?? -1] ?? "").trim();
    if (cells.length !== header.length) throw new ExportParseError(`${where}: ${cells.length} fields, expected ${header.length}`);
    const id = cell("id");
    if (!id) throw new ExportParseError(`${where}: empty id`);
    const currency = (() => {
      try { return normalizeCurrency(cell("currency")); } catch (e) { throw new ExportParseError(`${where}: ${(e as Error).message}`); }
    })();
    const toMinor = (raw: string, what: string): number => {
      try {
        if (minorUnits) {
          if (!/^-?\d{1,15}$/.test(raw)) throw new RangeError(`not an integer: ${JSON.stringify(raw)}`);
          return Number(raw);
        }
        return majorToMinor(raw, currency);
      } catch (e) {
        throw new ExportParseError(`${where}: ${what}: ${(e as Error).message}`);
      }
    };
    const amount = toMinor(cell("amount"), "amount");
    const created = parseCreated(cell("created"), where);
    const status = cell("status").toLowerCase() || null;
    const type = cell("type").toLowerCase();
    if (type === "refund" || type === "payment_refund" || id.startsWith("re_")) {
      rows.push({ kind: "refund", id, chargeId: cell("charge") || null, paymentIntent: cell("paymentIntent") || null, amount: Math.abs(amount), currency, status, created });
    } else {
      const refunded = cell("amountRefunded");
      rows.push({ kind: "charge", id, paymentIntent: cell("paymentIntent") || null, amount, currency, status, amountRefunded: refunded === "" ? null : toMinor(refunded, "amount refunded"), created });
    }
  }
  return { rows, skipped: 0 };
}

// ---- JSON ----------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const idOf = (v: unknown): string | null => (typeof v === "string" ? str(v) : typeof v === "object" && v !== null ? str((v as Obj)["id"]) : null);
function minor(o: Obj, key: string, where: string): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new ExportParseError(`${where}: "${key}" must be an integer in minor units`);
  assertMinorUnits(v);
  return v;
}
function currencyOf(o: Obj, where: string): string {
  try { return normalizeCurrency(String(o["currency"])); } catch (e) { throw new ExportParseError(`${where}: ${(e as Error).message}`); }
}
const createdOf = (o: Obj): number | null => (typeof o["created"] === "number" && Number.isSafeInteger(o["created"]) ? o["created"] : null);

function parseJsonExport(text: string): ParsedExport {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new ExportParseError(`JSON: ${(e as Error).message}`);
  }
  const list = Array.isArray(data) ? data : typeof data === "object" && data !== null && Array.isArray((data as Obj)["data"]) ? ((data as Obj)["data"] as unknown[]) : null;
  if (!list) throw new ExportParseError("JSON: expected an array or a Stripe list object with a data array");

  const rows: ExportRow[] = [];
  let skipped = 0;
  list.forEach((item, i) => {
    const where = `JSON item ${i}`;
    if (typeof item !== "object" || item === null) throw new ExportParseError(`${where}: not an object`);
    const o = item as Obj;
    const kind = o["object"];
    if (kind === "charge") {
      const id = str(o["id"]);
      if (!id) throw new ExportParseError(`${where}: charge without id`);
      rows.push({
        kind: "charge", id, paymentIntent: idOf(o["payment_intent"]), amount: minor(o, "amount", where), currency: currencyOf(o, where),
        status: str(o["status"])?.toLowerCase() ?? null,
        amountRefunded: o["amount_refunded"] === undefined ? null : minor(o, "amount_refunded", where),
        created: createdOf(o),
      });
    } else if (kind === "refund") {
      const id = str(o["id"]);
      if (!id) throw new ExportParseError(`${where}: refund without id`);
      rows.push({ kind: "refund", id, chargeId: idOf(o["charge"]), paymentIntent: idOf(o["payment_intent"]), amount: minor(o, "amount", where), currency: currencyOf(o, where), status: str(o["status"])?.toLowerCase() ?? null, created: createdOf(o) });
    } else if (kind === "balance_transaction") {
      const type = str(o["type"]);
      const source = idOf(o["source"]);
      if ((type === "charge" || type === "payment") && source) {
        rows.push({ kind: "charge", id: source, paymentIntent: null, amount: minor(o, "amount", where), currency: currencyOf(o, where), status: null, amountRefunded: null, created: createdOf(o) });
      } else if ((type === "refund" || type === "payment_refund") && source) {
        rows.push({ kind: "refund", id: source, chargeId: null, paymentIntent: null, amount: Math.abs(minor(o, "amount", where)), currency: currencyOf(o, where), status: null, created: createdOf(o) });
      } else {
        skipped += 1; // payouts, fees, adjustments, disputes ...
      }
    } else {
      throw new ExportParseError(`${where}: unsupported object ${JSON.stringify(kind)} (expected charge, refund or balance_transaction)`);
    }
  });
  return { rows, skipped };
}

/**
 * Reads a Stripe-style export. JSON holds integer minor units (as the API returns them); CSV holds
 * decimal major units like a Dashboard export ("49.00" USD, "1500" JPY) unless `minorUnits` is set.
 * The format is detected from the first character unless given.
 */
export function parseExport(text: string, options: { format?: "json" | "csv"; minorUnits?: boolean } = {}): ParsedExport {
  const format = options.format ?? (/^\s*[[{]/.test(text.replace(/^﻿/, "")) ? "json" : "csv");
  return format === "json" ? parseJsonExport(text.replace(/^﻿/, "")) : parseCsvExport(text, options.minorUnits ?? false);
}
