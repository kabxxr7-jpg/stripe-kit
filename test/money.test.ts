import { describe, expect, it } from "vitest";
import { formatMoney, majorToMinor, minorToMajor, minorUnitExponent, normalizeCurrency } from "../src/money.ts";

describe("minor unit exponents", () => {
  it("knows zero-decimal, two-decimal and three-decimal currencies", () => {
    expect(minorUnitExponent("jpy")).toBe(0);
    expect(minorUnitExponent("KRW")).toBe(0);
    expect(minorUnitExponent("usd")).toBe(2);
    expect(minorUnitExponent("EUR")).toBe(2);
    expect(minorUnitExponent("kwd")).toBe(3);
  });

  it("rejects things that are not currency codes", () => {
    expect(() => normalizeCurrency("us")).toThrow(RangeError);
    expect(() => normalizeCurrency("dollars")).toThrow(RangeError);
  });
});

describe("majorToMinor", () => {
  it("converts two-decimal currencies without float error", () => {
    expect(majorToMinor("15.00", "usd")).toBe(1500);
    expect(majorToMinor("0.29", "usd")).toBe(29); // 0.29 * 100 is 28.999999999999996 in floats
    expect(majorToMinor("19.9", "eur")).toBe(1990);
    expect(majorToMinor("-4.50", "eur")).toBe(-450);
    expect(majorToMinor("1,234.56", "usd")).toBe(123456);
  });

  it("does not multiply zero-decimal currencies by 100", () => {
    expect(majorToMinor("1500", "jpy")).toBe(1500);
    expect(majorToMinor("1500", "JPY")).toBe(1500);
    expect(majorToMinor("1500.00", "jpy")).toBe(1500);
  });

  it("handles three-decimal currencies", () => {
    expect(majorToMinor("1.234", "kwd")).toBe(1234);
  });

  it("refuses to round", () => {
    expect(() => majorToMinor("15.005", "usd")).toThrow(/more decimal places/);
    expect(() => majorToMinor("15.5", "jpy")).toThrow(/more decimal places/);
    expect(() => majorToMinor("abc", "usd")).toThrow(/not a decimal/);
    expect(() => majorToMinor("", "usd")).toThrow(/not a decimal/);
  });

  it("never returns negative zero", () => {
    expect(Object.is(majorToMinor("-0.00", "usd"), 0)).toBe(true);
  });
});

describe("minorToMajor / formatMoney", () => {
  it("formats by exponent", () => {
    expect(minorToMajor(1500, "usd")).toBe("15.00");
    expect(minorToMajor(5, "usd")).toBe("0.05");
    expect(minorToMajor(-450, "eur")).toBe("-4.50");
    expect(minorToMajor(1500, "jpy")).toBe("1500");
    expect(minorToMajor(1234, "kwd")).toBe("1.234");
    expect(formatMoney(4900, "usd")).toBe("USD 49.00");
    expect(formatMoney(1500, "jpy")).toBe("JPY 1500");
  });

  it("rejects non-integer minor units", () => {
    expect(() => minorToMajor(12.5, "usd")).toThrow(RangeError);
  });

  it("round-trips", () => {
    for (const [amount, cur] of [[0, "usd"], [1, "usd"], [99999999, "usd"], [1500, "jpy"], [-1, "jpy"], [1001, "kwd"]] as const) {
      expect(majorToMinor(minorToMajor(amount, cur), cur)).toBe(amount);
    }
  });
});
