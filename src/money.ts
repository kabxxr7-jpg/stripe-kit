/**
 * Stripe amounts are integers in the currency's smallest unit. Most currencies have two decimals,
 * a list of "zero-decimal" currencies (JPY, KRW, ...) has none, and a few have three.
 * https://docs.stripe.com/currencies#zero-decimal
 *
 * Nothing here uses floating point: decimal strings are parsed digit by digit.
 */
const ZERO_DECIMAL = new Set([
  "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf",
]);
const THREE_DECIMAL = new Set(["bhd", "jod", "kwd", "omr", "tnd"]);

/** Number of decimal places between the major unit and the minor unit. */
export function minorUnitExponent(currency: string): 0 | 2 | 3 {
  const c = normalizeCurrency(currency);
  if (ZERO_DECIMAL.has(c)) return 0;
  if (THREE_DECIMAL.has(c)) return 3;
  return 2;
}

/** Lower-case, three letters. Stripe uses lower case in the API; exports are often upper case. */
export function normalizeCurrency(currency: string): string {
  const c = currency.trim().toLowerCase();
  if (!/^[a-z]{3}$/.test(c)) throw new RangeError(`not a three-letter currency code: ${JSON.stringify(currency)}`);
  return c;
}

export function assertMinorUnits(amount: number, what = "amount"): void {
  if (!Number.isSafeInteger(amount)) throw new RangeError(`${what} must be an integer number of minor units, got ${amount}`);
}

/**
 * "15.00" USD -> 1500, "1500" JPY -> 1500, "-4.50" EUR -> -450.
 * Rejects more fractional digits than the currency has ("15.005" USD, "15.5" JPY) instead of rounding:
 * a silent rounding step is how reconciliation reports drift by a cent.
 */
export function majorToMinor(value: string, currency: string): number {
  const exponent = minorUnitExponent(currency);
  const m = /^([+-]?)(\d{1,15})(?:\.(\d+))?$/.exec(value.trim().replace(/,/g, ""));
  if (!m) throw new RangeError(`not a decimal amount: ${JSON.stringify(value)}`);
  const sign = m[1] === "-" ? -1 : 1;
  const whole = m[2] ?? "0";
  const fraction = m[3] ?? "";
  // trailing zeros beyond the exponent are harmless ("15.000" USD)
  const extra = fraction.slice(exponent);
  if (/[^0]/.test(extra)) {
    throw new RangeError(`${value} has more decimal places than ${normalizeCurrency(currency)} allows (${exponent})`);
  }
  const digits = whole + fraction.slice(0, exponent).padEnd(exponent, "0");
  const amount = sign * Number(digits);
  assertMinorUnits(amount);
  return amount === 0 ? 0 : amount; // never -0
}

/** 1500 USD -> "15.00", 1500 JPY -> "1500", -450 EUR -> "-4.50". */
export function minorToMajor(amount: number, currency: string): string {
  assertMinorUnits(amount);
  const exponent = minorUnitExponent(currency);
  const negative = amount < 0;
  const digits = String(Math.abs(amount)).padStart(exponent + 1, "0");
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = exponent === 0 ? "" : `.${digits.slice(digits.length - exponent)}`;
  return `${negative ? "-" : ""}${whole}${fraction}`;
}

/** "USD 15.00" for reports. */
export function formatMoney(amount: number, currency: string): string {
  return `${normalizeCurrency(currency).toUpperCase()} ${minorToMajor(amount, currency)}`;
}
