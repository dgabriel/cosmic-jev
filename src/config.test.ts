import { describe, expect, it } from "vitest";
import { parseOracleKind } from "./config";

describe("parseOracleKind", () => {
  it("defaults to stub when unset or empty", () => {
    expect(parseOracleKind(undefined)).toBe("stub");
    expect(parseOracleKind("")).toBe("stub");
  });

  it("accepts stub and jev", () => {
    expect(parseOracleKind("stub")).toBe("stub");
    expect(parseOracleKind("jev")).toBe("jev");
  });

  it("rejects unknown values", () => {
    expect(() => parseOracleKind("gpt")).toThrow(/Invalid VITE_ORACLE/);
  });
});
