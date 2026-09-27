import * as Astronomy from "astronomy-engine";
import { describe, expect, it } from "vitest";
import { computeNatalChart, type BirthDate } from "./natal";
import { signForLongitude, TRANSIT_BODIES } from "./sky";

// NOTE: like sky.test.ts, these tests cover mechanical/structural behavior
// only (timezone/local-noon arithmetic, the ambiguity mechanism, and the
// Ascendant's internal self-consistency), using arbitrary/synthetic dates
// and independently-recomputed expectations. They do NOT assert that any
// specific real calendar date is a "verified" Sun cusp day or that any
// specific Ascendant longitude is astronomically correct -- reference-value
// verification against a citation is a separate tester pass (bd oracle-bec),
// matching the pattern already used in sky.test.ts (bd oracle-6g3).

/** Builds a BirthDate from a UTC epoch instant's calendar date. */
function birthDateFromEpochMillis(epochMillis: number): BirthDate {
  const d = new Date(epochMillis);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

describe("computeNatalChart: timezone / local-noon instant resolution", () => {
  it("without a birth time, resolves to UTC noon when no utcOffsetMinutes is given (documented default)", () => {
    const chart = computeNatalChart({ date: { year: 2024, month: 5, day: 10 } });
    expect(chart.timeKnown).toBe(false);
    expect(chart.instant.toISOString()).toBe("2024-05-10T12:00:00.000Z");
  });

  it("without a birth time, applies an explicit utcOffsetMinutes to define local noon", () => {
    // Local noon in UTC-5 (e.g. US Eastern Standard Time) is 17:00 UTC.
    const chart = computeNatalChart({
      date: { year: 2024, month: 5, day: 10 },
      utcOffsetMinutes: -300,
    });
    expect(chart.instant.toISOString()).toBe("2024-05-10T17:00:00.000Z");
  });

  it("with a birth time and no utcOffsetMinutes, treats the clock time as UTC (documented default)", () => {
    const chart = computeNatalChart({
      date: { year: 2024, month: 5, day: 10 },
      time: { hour: 14, minute: 30 },
    });
    expect(chart.timeKnown).toBe(true);
    expect(chart.instant.toISOString()).toBe("2024-05-10T14:30:00.000Z");
  });

  it("with a birth time and a positive utcOffsetMinutes, converts local clock time to UTC", () => {
    // 14:30 local in UTC+5:30 (e.g. India Standard Time) is 09:00 UTC.
    const chart = computeNatalChart({
      date: { year: 2024, month: 5, day: 10 },
      time: { hour: 14, minute: 30 },
      utcOffsetMinutes: 330,
    });
    expect(chart.instant.toISOString()).toBe("2024-05-10T09:00:00.000Z");
  });

  it("correctly rolls the calendar date over when the offset pushes the instant to the next UTC day", () => {
    // 23:45 local in UTC-1 is 00:45 UTC on the *next* calendar day.
    const chart = computeNatalChart({
      date: { year: 2024, month: 5, day: 10 },
      time: { hour: 23, minute: 45 },
      utcOffsetMinutes: -60,
    });
    expect(chart.instant.toISOString()).toBe("2024-05-11T00:45:00.000Z");
  });
});

describe("computeNatalChart: shape and ambiguity-when-time-known", () => {
  it("produces a natal body position for every transit body, each with a boolean ambiguous flag", () => {
    const chart = computeNatalChart({ date: { year: 2024, month: 1, day: 1 } });
    expect(Object.keys(chart.bodies).sort()).toEqual([...TRANSIT_BODIES].sort());
    for (const bodyName of TRANSIT_BODIES) {
      const position = chart.bodies[bodyName];
      expect(position.body).toBe(bodyName);
      expect(typeof position.ambiguous).toBe("boolean");
      expect(position.longitude).toBeGreaterThanOrEqual(0);
      expect(position.longitude).toBeLessThan(360);
    }
  });

  it("never flags a body ambiguous when an exact birth time is known", () => {
    const dates: BirthDate[] = [
      { year: 2024, month: 1, day: 1 },
      { year: 2000, month: 6, day: 15 },
      { year: 2030, month: 11, day: 3 },
    ];
    for (const date of dates) {
      const chart = computeNatalChart({ date, time: { hour: 9, minute: 0 } });
      for (const bodyName of TRANSIT_BODIES) {
        expect(chart.bodies[bodyName].ambiguous).toBe(false);
      }
    }
  });

  it("echoes the input back on the chart unchanged", () => {
    const input = { date: { year: 2024, month: 1, day: 1 } };
    const chart = computeNatalChart(input);
    expect(chart.input).toEqual(input);
  });
});

describe("computeNatalChart: no-birth-time ambiguity mechanism", () => {
  /**
   * Independent (test-local) day-boundary sign check: recomputes, from
   * scratch via astronomy-engine directly (not by calling into natal.ts),
   * whether a body's sign differs between local midnight and the next local
   * midnight. Used as the "expected" value so this test is a genuine
   * cross-check of natal.ts's wiring, not a tautology.
   */
  function boundarySignsDiffer(astronomyBody: Astronomy.Body, startOfDayUtcMillis: number): boolean {
    const endOfDayUtcMillis = startOfDayUtcMillis + 24 * 60 * 60 * 1000;
    const signAt = (millis: number) => {
      const vector = Astronomy.GeoVector(astronomyBody, new Date(millis), true);
      const elon = Astronomy.Ecliptic(vector).elon;
      return signForLongitude(elon).sign;
    };
    return signAt(startOfDayUtcMillis) !== signAt(endOfDayUtcMillis);
  }

  it("matches an independent midnight-to-midnight check for the Sun across a full year, and hits both outcomes", () => {
    // 2024 is an arbitrary calendar year (not asserted as containing a
    // "verified" cusp date); scanning all of it just guarantees we exercise
    // both the ambiguous and non-ambiguous branches for a slow-moving body.
    const yearStartMillis = Date.UTC(2024, 0, 1, 0, 0, 0);
    let sawAmbiguousTrue = false;
    let sawAmbiguousFalse = false;
    for (let dayIndex = 0; dayIndex < 366; dayIndex++) {
      const startOfDayUtcMillis = yearStartMillis + dayIndex * 24 * 60 * 60 * 1000;
      const date = birthDateFromEpochMillis(startOfDayUtcMillis);
      const chart = computeNatalChart({ date });
      const expected = boundarySignsDiffer(Astronomy.Body.Sun, startOfDayUtcMillis);
      expect(chart.bodies.Sun.ambiguous).toBe(expected);
      if (expected) sawAmbiguousTrue = true;
      else sawAmbiguousFalse = true;
    }
    expect(sawAmbiguousTrue).toBe(true);
    expect(sawAmbiguousFalse).toBe(true);
  });

  it("matches an independent midnight-to-midnight check for the Moon across two months, and hits both outcomes", () => {
    // The Moon changes sign roughly every 2-3 days, so a couple of months is
    // enough to see it flip both ways without needing a full-year scan.
    const rangeStartMillis = Date.UTC(2024, 0, 1, 0, 0, 0);
    let sawAmbiguousTrue = false;
    let sawAmbiguousFalse = false;
    for (let dayIndex = 0; dayIndex < 60; dayIndex++) {
      const startOfDayUtcMillis = rangeStartMillis + dayIndex * 24 * 60 * 60 * 1000;
      const date = birthDateFromEpochMillis(startOfDayUtcMillis);
      const chart = computeNatalChart({ date });
      const expected = boundarySignsDiffer(Astronomy.Body.Moon, startOfDayUtcMillis);
      expect(chart.bodies.Moon.ambiguous).toBe(expected);
      if (expected) sawAmbiguousTrue = true;
      else sawAmbiguousFalse = true;
    }
    expect(sawAmbiguousTrue).toBe(true);
    expect(sawAmbiguousFalse).toBe(true);
  });

  it("covers a Pisces -> Aries wraparound day the same way as any other cusp (sign inequality, not a numeric threshold)", () => {
    // Any day where the independent check flags a sign difference exercises
    // this path, including wraparound days, since signForLongitude (reused
    // from sky.ts) already normalizes longitudes into [0, 360) beforehand.
    // We don't need a separate code path here -- just confirm the mechanism
    // fires around the vernal-equinox season (Sun near the Pisces/Aries
    // boundary), without asserting a specific verified date.
    const marchStartMillis = Date.UTC(2024, 2, 1, 0, 0, 0);
    let sawAmbiguousTrue = false;
    for (let dayIndex = 0; dayIndex < 31; dayIndex++) {
      const startOfDayUtcMillis = marchStartMillis + dayIndex * 24 * 60 * 60 * 1000;
      const date = birthDateFromEpochMillis(startOfDayUtcMillis);
      const chart = computeNatalChart({ date });
      if (chart.bodies.Sun.ambiguous) {
        sawAmbiguousTrue = true;
        expect(chart.bodies.Sun.sign === "Pisces" || chart.bodies.Sun.sign === "Aries").toBe(true);
      }
    }
    expect(sawAmbiguousTrue).toBe(true);
  });
});

describe("computeNatalChart: Ascendant availability", () => {
  const date = { year: 2024, month: 5, day: 10 };
  const time = { hour: 8, minute: 15 };
  const location = { latitude: 40.7128, longitude: -74.006 }; // arbitrary coordinates

  it("is 'not-computed' when neither time nor location is given", () => {
    expect(computeNatalChart({ date }).ascendant).toEqual({ status: "not-computed" });
  });

  it("is 'not-computed' when only a birth time is given (no location)", () => {
    expect(computeNatalChart({ date, time }).ascendant).toEqual({ status: "not-computed" });
  });

  it("is 'not-computed' when only a location is given (no birth time)", () => {
    expect(computeNatalChart({ date, location }).ascendant).toEqual({ status: "not-computed" });
  });

  it("is 'ok' with a valid position when both birth time and location are given, at an ordinary latitude", () => {
    const chart = computeNatalChart({ date, time, location });
    const ascendant = chart.ascendant;
    if (ascendant.status !== "ok") throw new Error(`expected status "ok", got ${ascendant.status}`);
    expect(ascendant.position.longitude).toBeGreaterThanOrEqual(0);
    expect(ascendant.position.longitude).toBeLessThan(360);
    expect(ascendant.position.degreeInSign).toBeGreaterThanOrEqual(0);
    expect(ascendant.position.degreeInSign).toBeLessThan(30);
    expect(ascendant.position.sign).toBe(signForLongitude(ascendant.position.longitude).sign);
  });
});

describe("computeNatalChart: Ascendant unreliable near the poles (oracle-55h review fix)", () => {
  // Reviewer-reported bug: near latitude ~66.56deg (Arctic/Antarctic Circle)
  // the ecliptic pole can pass close to the zenith at specific sidereal
  // times, making the east/west selection numerically unstable (a ~180deg
  // flip from a 2-minute birth-time change); at exactly +/-90deg latitude
  // the result can look confident (large margin) yet still be physically
  // meaningless, since nothing rises or sets there at all. Both must be
  // surfaced as "unreliable", not silently returned as if valid.

  it("flags 'unreliable' at ~66.56 degrees latitude, at a birth time where the east/west margin is known to be small", () => {
    // 2024-03-28T06:45:00Z was found (see dev notes / PR description) to sit
    // right in the ~0.01-margin instability window at this latitude -- not
    // asserted as a "verified" real cusp/ascendant event, just a witness
    // that the instability guard actually fires when the margin is small.
    const chart = computeNatalChart({
      date: { year: 2024, month: 3, day: 28 },
      time: { hour: 6, minute: 45 },
      utcOffsetMinutes: 0,
      location: { latitude: 66.56, longitude: -18 },
    });
    expect(chart.ascendant.status).toBe("unreliable");
    if (chart.ascendant.status === "unreliable") {
      expect(chart.ascendant.reason.length).toBeGreaterThan(0);
    }
  });

  it("flags 'unreliable' at exactly +90 degrees latitude, even at a birth time where the east/west margin alone would look confident", () => {
    // At 2024-05-10T02:45:00Z the margin computed at the true pole is
    // ~0.9998 (nowhere near EAST_WEST_MARGIN_THRESHOLD) -- yet at that same
    // instant the *answer* still collapses to one of exactly two fixed
    // values depending only on which half-plane `location.longitude` falls
    // in (verified during review: not a real function of the birth
    // instant), because longitude has no physical meaning at the pole.
    // This demonstrates the margin check alone would *not* catch this
    // moment -- the explicit polar guard is what makes it reliably flagged
    // regardless of the time chosen.
    const chart = computeNatalChart({
      date: { year: 2024, month: 5, day: 10 },
      time: { hour: 2, minute: 45 },
      utcOffsetMinutes: 0,
      location: { latitude: 90, longitude: 0 },
    });
    expect(chart.ascendant).toEqual({
      status: "unreliable",
      reason: expect.any(String),
    });
  });

  it("flags 'unreliable' at exactly -90 degrees latitude the same way", () => {
    const chart = computeNatalChart({
      date: { year: 2024, month: 5, day: 10 },
      time: { hour: 2, minute: 45 },
      utcOffsetMinutes: 0,
      location: { latitude: -90, longitude: 0 },
    });
    expect(chart.ascendant.status).toBe("unreliable");
  });

  it("flags 'unreliable' at 89.5 degrees N, 2024-05-10T08:15:00Z (reviewer-reported gap in the previous 0.1 threshold)", () => {
    // Reviewer found margin ~0.113 here: above the *previous*
    // EAST_WEST_MARGIN_THRESHOLD of 0.1 (so it wrongly reported "ok"), but
    // still well within the instability band once the threshold was raised
    // to 0.2 based on the worst-case-per-latitude scan (see that constant's
    // comment). This is a direct regression test for that exact report.
    const chart = computeNatalChart({
      date: { year: 2024, month: 5, day: 10 },
      time: { hour: 8, minute: 15 },
      utcOffsetMinutes: 0,
      location: { latitude: 89.5, longitude: 0 },
    });
    expect(chart.ascendant.status).toBe("unreliable");
  });

  it("does not flag ordinary mid-latitude locations as unreliable (regression guard)", () => {
    // Same birth time/location combinations as the self-consistency suite
    // below -- confirms the new instability guards don't over-trigger for
    // everyday inputs.
    const midLatitudeCases = [
      { time: { hour: 3, minute: 0 }, location: { latitude: 40.7128, longitude: -74.006 } },
      { time: { hour: 11, minute: 45 }, location: { latitude: -33.8688, longitude: 151.2093 } },
      { time: { hour: 18, minute: 30 }, location: { latitude: 51.5074, longitude: -0.1278 } },
      { time: { hour: 0, minute: 5 }, location: { latitude: 35.6762, longitude: 139.6503 } },
    ];
    for (const { time, location } of midLatitudeCases) {
      const chart = computeNatalChart({
        date: { year: 2024, month: 5, day: 10 },
        time,
        location,
      });
      expect(chart.ascendant.status).toBe("ok");
    }
  });
});

describe("computeNatalChart: BirthLocation range validation", () => {
  const date = { year: 2024, month: 1, day: 1 };
  const time = { hour: 12, minute: 0 };

  it("throws for a latitude outside [-90, 90]", () => {
    expect(() =>
      computeNatalChart({ date, time, location: { latitude: 91, longitude: 0 } }),
    ).toThrow();
    expect(() =>
      computeNatalChart({ date, time, location: { latitude: -91, longitude: 0 } }),
    ).toThrow();
  });

  it("throws for a longitude outside [-180, 180]", () => {
    expect(() =>
      computeNatalChart({ date, time, location: { latitude: 0, longitude: 181 } }),
    ).toThrow();
    expect(() =>
      computeNatalChart({ date, time, location: { latitude: 0, longitude: -181 } }),
    ).toThrow();
  });

  it("accepts the boundary values themselves", () => {
    expect(() =>
      computeNatalChart({ date, time, location: { latitude: 90, longitude: 180 } }),
    ).not.toThrow();
    expect(() =>
      computeNatalChart({ date, time, location: { latitude: -90, longitude: -180 } }),
    ).not.toThrow();
  });
});

describe("computeNatalChart: Ascendant self-consistency (new/unverified math -- extra scrutiny)", () => {
  // These tests cross-check natal.ts's hand-written rotation-matrix dot
  // product against astronomy-engine's own `RotateVector`, using several
  // arbitrary birth time/location combinations. They confirm the returned
  // Ascendant longitude actually sits on the local horizon (altitude ~ 0)
  // on the eastern side of the sky (per the HOR frame's x=north, y=west,
  // z=zenith convention) -- they do not assert any specific real-world
  // Ascendant value.
  const cases: { time: { hour: number; minute: number }; location: { latitude: number; longitude: number } }[] = [
    { time: { hour: 3, minute: 0 }, location: { latitude: 40.7128, longitude: -74.006 } },
    { time: { hour: 11, minute: 45 }, location: { latitude: -33.8688, longitude: 151.2093 } },
    { time: { hour: 18, minute: 30 }, location: { latitude: 51.5074, longitude: -0.1278 } },
    { time: { hour: 0, minute: 5 }, location: { latitude: 35.6762, longitude: 139.6503 } },
  ];

  for (const { time, location } of cases) {
    it(`places the Ascendant on the eastern horizon (lat ${location.latitude}, lon ${location.longitude}, ${time.hour}:${time.minute})`, () => {
      const chart = computeNatalChart({
        date: { year: 2024, month: 5, day: 10 },
        time,
        location,
      });
      const ascendant = chart.ascendant;
      if (ascendant.status !== "ok") {
        throw new Error(`expected status "ok" for a mid-latitude case, got ${ascendant.status}`);
      }

      const observer = new Astronomy.Observer(location.latitude, location.longitude, 0);
      const ectToEqd = Astronomy.Rotation_ECT_EQD(chart.instant);
      const eqdToHor = Astronomy.Rotation_EQD_HOR(chart.instant, observer);
      const ectToHor = Astronomy.CombineRotation(ectToEqd, eqdToHor);

      const lonRad = (ascendant.position.longitude * Math.PI) / 180;
      const astroTime = Astronomy.MakeTime(chart.instant);
      const eclipticPointVector = new Astronomy.Vector(Math.cos(lonRad), Math.sin(lonRad), 0, astroTime);
      const horVector = Astronomy.RotateVector(ectToHor, eclipticPointVector);

      // On the horizon: the zenith (z, "up") component should be ~0.
      expect(Math.abs(horVector.z)).toBeLessThan(1e-9);
      // On the eastern side: HOR's y-axis points west, so east is negative y.
      expect(horVector.y).toBeLessThan(0);
    });
  }
});
