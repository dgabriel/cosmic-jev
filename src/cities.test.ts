import { describe, expect, it } from "vitest";
import { citiesFromRows, resolveCity, searchCities, utcOffsetMinutesAt, type CityRow } from "./cities";

// A hand-picked slice of the real cities.json rows, in its population order.
const ROWS: CityRow[] = [
  ["Tokyo", "Tokyo", "JP", 35.69, 139.69, "Asia/Tokyo"],
  ["São Paulo", "São Paulo", "BR", -23.55, -46.64, "America/Sao_Paulo"],
  ["Paris", "Île-de-France", "FR", 48.85, 2.35, "Europe/Paris"],
  ["Portland", "Oregon", "US", 45.52, -122.68, "America/Los_Angeles"],
  ["Eugene", "Oregon", "US", 44.05, -123.09, "America/Los_Angeles"],
  ["Paris", "Texas", "US", 33.66, -95.56, "America/Chicago"],
];
const CITIES = citiesFromRows(ROWS);

describe("citiesFromRows", () => {
  it("builds 'City, Region, Country' labels and drops a region that repeats the city", () => {
    expect(CITIES[3]?.label).toBe("Portland, Oregon, United States");
    expect(CITIES[0]?.label).toBe("Tokyo, Japan");
  });
});

describe("searchCities", () => {
  it("matches name prefixes accent-insensitively", () => {
    expect(searchCities(CITIES, "sao p").map((c) => c.name)).toEqual(["São Paulo"]);
  });

  it("lists name-prefix matches before region matches, in population order", () => {
    expect(searchCities(CITIES, "par").map((c) => c.label)).toEqual([
      "Paris, Île-de-France, France",
      "Paris, Texas, United States",
    ]);
    expect(searchCities(CITIES, "oregon").map((c) => c.name)).toEqual(["Portland", "Eugene"]);
  });

  it("returns nothing for a blank query and respects the limit", () => {
    expect(searchCities(CITIES, "  ")).toEqual([]);
    expect(searchCities(CITIES, "o", 1)).toHaveLength(1);
  });
});

describe("resolveCity", () => {
  it("resolves an exact autocomplete label", () => {
    expect(resolveCity(CITIES, "Paris, Texas, United States")?.timeZone).toBe("America/Chicago");
  });

  it("resolves a bare name to its most populous match", () => {
    expect(resolveCity(CITIES, "paris")?.countryCode).toBe("FR");
  });

  it("resolves 'City, Region' and 'City, Country' without the full label", () => {
    expect(resolveCity(CITIES, "Portland, Oregon")?.timeZone).toBe("America/Los_Angeles");
    expect(resolveCity(CITIES, "paris, texas")?.countryCode).toBe("US");
    expect(resolveCity(CITIES, "Paris, France")?.countryCode).toBe("FR");
    expect(resolveCity(CITIES, "Paris, US")?.admin1).toBe("Texas");
    expect(resolveCity(CITIES, "Portland, Maine")).toBeUndefined();
  });

  it("returns undefined for unknown or blank text", () => {
    expect(resolveCity(CITIES, "Atlantis")).toBeUndefined();
    expect(resolveCity(CITIES, "")).toBeUndefined();
  });
});

// Expected offsets are from the IANA tz database (https://www.iana.org/time-zones,
// files "northamerica", "asia", "europe"), which Intl uses under the hood.
describe("utcOffsetMinutesAt", () => {
  it("applies US Eastern DST in summer and standard time in winter", () => {
    expect(utcOffsetMinutesAt("America/New_York", { year: 1990, month: 7, day: 4 })).toBe(-240);
    expect(utcOffsetMinutesAt("America/New_York", { year: 1990, month: 1, day: 15 })).toBe(-300);
  });

  it("handles half-hour zones", () => {
    expect(utcOffsetMinutesAt("Asia/Kolkata", { year: 2000, month: 3, day: 1 }, { hour: 6, minute: 0 })).toBe(330);
  });

  it("uses historical rules: the UK kept UTC+1 all year from 1968 to 1971", () => {
    expect(utcOffsetMinutesAt("Europe/London", { year: 1970, month: 1, day: 10 })).toBe(60);
    expect(utcOffsetMinutesAt("Europe/London", { year: 1990, month: 1, day: 10 })).toBe(0);
  });
});
