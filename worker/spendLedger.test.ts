import { describe, expect, it } from "vitest";
import {
  DEFAULT_CAP_USD,
  SPEND_WINDOW_MS,
  UNKNOWN_BUCKET,
  ipBucket,
  isExemptBucket,
  mergeLedger,
  parseCap,
  roundUsd,
} from "./spendLedger";

describe("ipBucket", () => {
  it("buckets IPv4 by exact address, normalizing leading zeros", () => {
    expect(ipBucket("203.0.113.7")).toBe("203.0.113.7");
    expect(ipBucket(" 10.0.0.1 ")).toBe("10.0.0.1");
    expect(ipBucket("010.0.0.1")).toBe("10.0.0.1");
  });

  it("collapses IPv6 to the /64 prefix regardless of the lower 64 bits", () => {
    expect(ipBucket("2001:db8:1234:abcd::1")).toBe("2001:0db8:1234:abcd::/64");
    // Two addresses that share only their first 64 bits share one budget.
    expect(ipBucket("2001:db8:1234:abcd:beef::1")).toBe(ipBucket("2001:db8:1234:abcd:cafe::2"));
    // ...but a different first-64 is a different bucket.
    expect(ipBucket("2001:db8:1234:abce::1")).not.toBe(ipBucket("2001:db8:1234:abcd::1"));
  });

  it("normalizes case, compression and full forms", () => {
    expect(ipBucket("2001:DB8:1234:ABCD::1")).toBe(ipBucket("2001:db8:1234:abcd::1"));
    expect(ipBucket("2001:0db8:1234:abcd:0000:0000:0000:0001")).toBe("2001:0db8:1234:abcd::/64");
    expect(ipBucket("::1")).toBe("0000:0000:0000:0000::/64");
  });

  it("buckets IPv4-mapped IPv6 as the IPv4 address", () => {
    expect(ipBucket("::ffff:203.0.113.7")).toBe("203.0.113.7");
  });

  it("buckets missing or malformed headers as unknown (capped, never bypassed)", () => {
    expect(ipBucket(null)).toBe(UNKNOWN_BUCKET);
    expect(ipBucket("")).toBe(UNKNOWN_BUCKET);
    expect(ipBucket("   ")).toBe(UNKNOWN_BUCKET);
    expect(ipBucket("not-an-ip")).toBe(UNKNOWN_BUCKET);
    expect(ipBucket("256.1.1.1")).toBe(UNKNOWN_BUCKET);
    expect(ipBucket("2001:::1")).toBe(UNKNOWN_BUCKET);
    expect(ipBucket("2001:db8::1::2")).toBe(UNKNOWN_BUCKET);
  });
});

describe("isExemptBucket", () => {
  const LIST = "203.0.113.7, 198.51.100.4 ,2001:db8:1234::/64";

  it("matches listed IPv4 addresses exactly", () => {
    expect(isExemptBucket("203.0.113.7", LIST)).toBe(true);
    expect(isExemptBucket("198.51.100.4", LIST)).toBe(true);
    expect(isExemptBucket("203.0.113.8", LIST)).toBe(false);
  });

  it("matches IPv6 /64 entries against /64 buckets", () => {
    // The fourth hextet is inside the /64; the lower 64 bits ride free.
    expect(isExemptBucket(ipBucket("2001:DB8:1234:0:ffff::9"), LIST)).toBe(true);
    expect(isExemptBucket(ipBucket("2001:db8:1235::1"), LIST)).toBe(false);
  });

  it("is false for empty lists and ignores malformed entries", () => {
    expect(isExemptBucket("203.0.113.7", undefined)).toBe(false);
    expect(isExemptBucket("203.0.113.7", "")).toBe(false);
    expect(isExemptBucket("203.0.113.7", "banana, 999.1.1.1, ::::/64")).toBe(false);
    expect(isExemptBucket("203.0.113.7", "banana,203.0.113.7")).toBe(true);
  });
});

describe("parseCap", () => {
  it("defaults when unset or blank", () => {
    expect(parseCap(undefined)).toBe(DEFAULT_CAP_USD);
    expect(parseCap("")).toBe(DEFAULT_CAP_USD);
    expect(parseCap("  ")).toBe(DEFAULT_CAP_USD);
  });

  it("accepts positive numbers and rejects the rest (handler fails closed)", () => {
    expect(parseCap("0.01")).toBe(0.01);
    expect(parseCap("0.000005")).toBe(0.000005);
    expect(parseCap("0")).toBeNull();
    expect(parseCap("-1")).toBeNull();
    expect(parseCap("banana")).toBeNull();
    expect(parseCap("Infinity")).toBeNull();
  });
});

describe("roundUsd", () => {
  it("cleans float dust without moving real amounts", () => {
    expect(roundUsd(0.1 + 0.2)).toBe(0.3);
    expect(roundUsd(0.00001197 * 800)).toBe(0.009576);
    expect(roundUsd(0)).toBe(0);
  });
});

describe("mergeLedger", () => {
  it("unions both tables: all-time = pruned totals + live charges", () => {
    const merged = mergeLedger(
      [{ bucket: "10.0.0.1", total: 0.004 }],
      [
        { bucket: "10.0.0.1", chargesTotal: 0.002, windowTotal: 0.002, lastMs: 777 },
        { bucket: "10.0.0.2", chargesTotal: 0.00003, windowTotal: 0.00003, lastMs: 888 },
      ],
    );
    const byBucket = new Map(merged.map((b) => [b.bucket, b]));
    expect(byBucket.get("10.0.0.1")).toEqual({
      bucket: "10.0.0.1",
      spend7dUsd: 0.002,
      totalUsd: 0.006,
      lastChargeMs: 777,
    });
    expect(byBucket.get("10.0.0.2")!.totalUsd).toBe(0.00003);
  });

  it("reports totals-only buckets (fully pruned) with a null last charged time", () => {
    const merged = mergeLedger([{ bucket: "10.0.0.1", total: 0.01 }], []);
    expect(merged).toEqual([
      { bucket: "10.0.0.1", spend7dUsd: 0, totalUsd: 0.01, lastChargeMs: null },
    ]);
  });

  it("keeps display sums dust-free even over many tiny charges", () => {
    const chargesTotal = 0.00001197 * 833; // ~one full $0.01 cap
    const [b] = mergeLedger(
      [],
      [{ bucket: "10.0.0.1", chargesTotal, windowTotal: chargesTotal, lastMs: 1 }],
    );
    if (b === undefined) throw new Error("merge produced no bucket");
    expect(b.totalUsd).toBe(roundUsd(chargesTotal));
    expect(b.spend7dUsd).toBe(roundUsd(chargesTotal));
  });
});

describe("SPEND_WINDOW_MS", () => {
  it("is 7 days of milliseconds", () => {
    expect(SPEND_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
