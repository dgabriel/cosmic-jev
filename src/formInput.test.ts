import { describe, expect, it } from "vitest";
import {
  formatBirthDateInput,
  formatBirthTimeInput,
  parseBirthDate,
  parseBirthTime,
  parseLocation,
  parseUtcOffsetMinutes,
} from "./formInput";

describe("parseBirthDate", () => {
  it("parses a YYYY-MM-DD date input value", () => {
    expect(parseBirthDate("1990-07-04")).toEqual({ year: 1990, month: 7, day: 4 });
  });
});

describe("formatBirthDateInput", () => {
  it("is the inverse of parseBirthDate, zero-padded, and round-trips", () => {
    expect(formatBirthDateInput({ year: 1990, month: 7, day: 4 })).toBe("1990-07-04");
    expect(formatBirthDateInput(parseBirthDate("1990-07-04"))).toBe("1990-07-04");
  });
});

describe("parseBirthTime", () => {
  it("returns undefined for a blank value", () => {
    expect(parseBirthTime("")).toBeUndefined();
    expect(parseBirthTime("   ")).toBeUndefined();
  });

  it("parses an HH:MM time input value", () => {
    expect(parseBirthTime("09:05")).toEqual({ hour: 9, minute: 5 });
  });
});

describe("formatBirthTimeInput", () => {
  it("is the inverse of parseBirthTime, zero-padded, and round-trips", () => {
    expect(formatBirthTimeInput({ hour: 9, minute: 5 })).toBe("09:05");
    expect(formatBirthTimeInput(parseBirthTime("09:05")!)).toBe("09:05");
  });
});

describe("parseUtcOffsetMinutes", () => {
  it("returns undefined for a blank value", () => {
    expect(parseUtcOffsetMinutes("")).toBeUndefined();
    expect(parseUtcOffsetMinutes("   ")).toBeUndefined();
  });

  it("converts whole and fractional hours to minutes", () => {
    expect(parseUtcOffsetMinutes("-5")).toBe(-300);
    expect(parseUtcOffsetMinutes("5.5")).toBe(330);
  });

  it("returns undefined for an unparseable value", () => {
    expect(parseUtcOffsetMinutes("not a number")).toBeUndefined();
  });
});

describe("parseLocation", () => {
  it("returns no location and no error when both fields are blank", () => {
    expect(parseLocation("", "")).toEqual({});
  });

  it("returns a location when both fields are valid numbers in range", () => {
    expect(parseLocation("40.71", "-74.01")).toEqual({
      location: { latitude: 40.71, longitude: -74.01 },
    });
  });

  it("errors when only one of latitude/longitude is given", () => {
    expect(parseLocation("40.71", "")).toEqual({
      error: "Enter both latitude and longitude, or leave both blank.",
    });
    expect(parseLocation("", "-74.01")).toEqual({
      error: "Enter both latitude and longitude, or leave both blank.",
    });
  });

  it("errors on non-numeric input", () => {
    expect(parseLocation("north", "-74.01")).toEqual({
      error: "Latitude and longitude must be numbers.",
    });
  });

  it("errors with a specific message on out-of-range latitude, not a generic error", () => {
    expect(parseLocation("91", "0")).toEqual({ error: "Latitude must be between -90 and 90." });
    expect(parseLocation("-91", "0")).toEqual({ error: "Latitude must be between -90 and 90." });
  });

  it("errors with a specific message on out-of-range longitude, not a generic error", () => {
    expect(parseLocation("0", "181")).toEqual({ error: "Longitude must be between -180 and 180." });
    expect(parseLocation("0", "-181")).toEqual({ error: "Longitude must be between -180 and 180." });
  });

  it("accepts the exact boundary values", () => {
    expect(parseLocation("90", "180")).toEqual({ location: { latitude: 90, longitude: 180 } });
    expect(parseLocation("-90", "-180")).toEqual({ location: { latitude: -90, longitude: -180 } });
  });
});
