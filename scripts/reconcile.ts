// Compares a Stripe-style export (JSON or CSV) with the local database.
//   npm run reconcile -- --export export.json [--db data/stripe-kit.db] [--minor-units] [--from 2026-01-01] [--until 2026-02-01] [--json]
// Exit code: 0 clean, 1 discrepancies found, 2 bad input.
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { ExportParseError, parseExport } from "../src/export.ts";
import { exitCode, formatReport, reconcile } from "../src/reconcile.ts";
import { parseArgs } from "./args.ts";

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}
function toSeconds(value: string | true | undefined, end: boolean): number | undefined {
  if (value === undefined) return undefined;
  if (value === true) fail("--from/--until need a value");
  if (/^\d{9,11}$/.test(value)) return Number(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(`cannot read date ${JSON.stringify(value)} (use YYYY-MM-DD or epoch seconds)`);
  return Math.floor(Date.parse(`${value}T00:00:00Z`) / 1000) + (end ? 86399 : 0);
}

const { flags } = parseArgs(process.argv.slice(2), ["export", "db", "from", "until"]);
const exportPath = flags.get("export");
if (typeof exportPath !== "string") fail("usage: npm run reconcile -- --export <file.json|file.csv> [--db path] [--minor-units] [--from date] [--until date] [--json]");
const dbPath = String(flags.get("db") ?? "data/stripe-kit.db");
if (!existsSync(exportPath)) fail(`export file not found: ${exportPath}`);
if (!existsSync(dbPath)) fail(`database not found: ${dbPath}`);

let parsed;
try {
  parsed = parseExport(readFileSync(exportPath, "utf8"), { minorUnits: flags.has("minor-units") });
} catch (error) {
  if (error instanceof ExportParseError) fail(`cannot read the export: ${error.message}`);
  throw error;
}
const from = toSeconds(flags.get("from"), false);
const until = toSeconds(flags.get("until"), true);
const db = new DatabaseSync(dbPath, { readOnly: true });
const result = reconcile({ rows: parsed.rows, db, ...(from === undefined ? {} : { from }), ...(until === undefined ? {} : { until }) });
console.log(flags.has("json") ? JSON.stringify(result, null, 2) : formatReport(result));
process.exitCode = exitCode(result);
