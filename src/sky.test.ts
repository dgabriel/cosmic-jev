import { describe, expect, it } from "vitest";
import {
  computeTransitChart,
  moonPhaseName,
  MOON_PHASE_NAMES,
  normalizeLongitudeDelta,
  signForLongitude,
  TRANSIT_BODIES,
  ZODIAC_SIGNS,
} from "./sky";

// NOTE: these tests cover mechanical/structural behavior only (sign math,
// wraparound normalization, Sun/Moon never-retrograde, chart shape) using
// arbitrary/synthetic dates and synthetic longitude values. They do NOT
// assert any real-world planetary longitude or retrograde status as
// "correct" -- that reference-value verification (JPL Horizons or a
// published retrograde calendar) is a separate tester pass (bd oracle-bec).

describe("signForLongitude", () => {
  it("maps 0 to Aries at 0 degrees", () => {
    expect(signForLongitude(0)).toEqual({ sign: "Aries", degreeInSign: 0 });
  });

  it("maps mid-sign longitudes to the right sign and degree", () => {
    expect(signForLongitude(45)).toEqual({ sign: "Taurus", degreeInSign: 15 });
    expect(signForLongitude(200)).toEqual({ sign: "Libra", degreeInSign: 20 });
  });

  it("handles the Pisces -> Aries wraparound just below and at 360", () => {
    expect(signForLongitude(359.5)).toEqual({ sign: "Pisces", degreeInSign: 29.5 });
    expect(signForLongitude(360)).toEqual({ sign: "Aries", degreeInSign: 0 });
    expect(signForLongitude(0.5)).toEqual({ sign: "Aries", degreeInSign: 0.5 });
  });

  it("normalizes negative longitudes into [0, 360)", () => {
    expect(signForLongitude(-1)).toEqual({ sign: "Pisces", degreeInSign: 29 });
  });

  it("covers all 12 signs at their lower boundary", () => {
    ZODIAC_SIGNS.forEach((sign, index) => {
      expect(signForLongitude(index * 30).sign).toBe(sign);
    });
  });
});

describe("normalizeLongitudeDelta (360 -> 0 wraparound)", () => {
  it("reads a small forward step across the 360/0 seam as small and positive", () => {
    // longitude goes from 359 to 1: naive subtraction gives -358, but the
    // body actually moved forward by 2 degrees.
    expect(normalizeLongitudeDelta(1 - 359)).toBe(2);
  });

  it("reads a small backward step across the 0/360 seam as small and negative", () => {
    // longitude goes from 1 to 359 (retrograde crossing the seam backwards):
    // naive subtraction gives 358, but the body actually moved backward by 2.
    expect(normalizeLongitudeDelta(359 - 1)).toBe(-2);
  });

  it("leaves deltas already within range untouched", () => {
    expect(normalizeLongitudeDelta(10)).toBe(10);
    expect(normalizeLongitudeDelta(-10)).toBe(-10);
  });

  it("keeps exactly 180 as 180 and normalizes -180 to 180 (half-open range)", () => {
    expect(normalizeLongitudeDelta(180)).toBe(180);
    expect(normalizeLongitudeDelta(-180)).toBe(180);
  });
});

describe("moonPhaseName", () => {
  it("names each cardinal phase angle", () => {
    expect(moonPhaseName(0)).toBe("new");
    expect(moonPhaseName(45)).toBe("waxing crescent");
    expect(moonPhaseName(90)).toBe("first quarter");
    expect(moonPhaseName(135)).toBe("waxing gibbous");
    expect(moonPhaseName(180)).toBe("full");
    expect(moonPhaseName(225)).toBe("waning gibbous");
    expect(moonPhaseName(270)).toBe("last quarter");
    expect(moonPhaseName(315)).toBe("waning crescent");
  });

  it("wraps waning crescent back around to new near 360/0", () => {
    expect(moonPhaseName(337.4)).toBe("waning crescent");
    expect(moonPhaseName(337.5)).toBe("new");
    expect(moonPhaseName(359.9)).toBe("new");
    expect(moonPhaseName(22.4)).toBe("new");
    expect(moonPhaseName(22.5)).toBe("waxing crescent");
  });
});

describe("computeTransitChart", () => {
  // Arbitrary synthetic dates, not asserted against any reference ephemeris.
  const synthenticDates = [
    new Date("2024-01-01T00:00:00Z"),
    new Date("2000-06-15T12:00:00Z"),
    new Date("2030-11-03T05:30:00Z"),
  ];

  it("never reads the system clock (date is fully caller-controlled)", () => {
    const fixedDate = new Date("2024-03-20T00:00:00Z");
    const a = computeTransitChart(fixedDate);
    const b = computeTransitChart(fixedDate);
    expect(a).toEqual(b);
  });

  it("always flags Sun and Moon as not retrograde", () => {
    for (const date of synthenticDates) {
      const chart = computeTransitChart(date);
      expect(chart.bodies.Sun.retrograde).toBe(false);
      expect(chart.bodies.Moon.retrograde).toBe(false);
    }
  });

  it("produces a body position for every transit body with values in range", () => {
    for (const date of synthenticDates) {
      const chart = computeTransitChart(date);
      expect(Object.keys(chart.bodies).sort()).toEqual([...TRANSIT_BODIES].sort());

      for (const bodyName of TRANSIT_BODIES) {
        const position = chart.bodies[bodyName];
        expect(position.body).toBe(bodyName);
        expect(position.longitude).toBeGreaterThanOrEqual(0);
        expect(position.longitude).toBeLessThan(360);
        expect(position.degreeInSign).toBeGreaterThanOrEqual(0);
        expect(position.degreeInSign).toBeLessThan(30);
        expect(ZODIAC_SIGNS).toContain(position.sign);
        expect(typeof position.retrograde).toBe("boolean");
      }
    }
  });

  it("produces a moon phase angle and name that agree, within a valid chart shape", () => {
    for (const date of synthenticDates) {
      const chart = computeTransitChart(date);
      expect(chart.moonPhaseAngle).toBeGreaterThanOrEqual(0);
      expect(chart.moonPhaseAngle).toBeLessThan(360);
      expect(MOON_PHASE_NAMES).toContain(chart.moonPhase);
      expect(chart.moonPhase).toBe(moonPhaseName(chart.moonPhaseAngle));
      expect(chart.date).toBe(date);
    }
  });
});
