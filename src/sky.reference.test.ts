/**
 * Reference-ephemeris-verified tests (bd oracle-bec).
 *
 * Unlike sky.test.ts / natal.test.ts (which cover mechanical/structural
 * behavior only, per their own header comments), every expected value in
 * THIS file is taken from an external, cited reference and is NOT computed
 * or invented by this codebase. Where a date sits close to a boundary, the
 * comment says how far away it is and why that margin is safe.
 *
 * Sources cited below (as supplied for this task; agent had no live web
 * access and used values looked up against live pages on 2026-09-27):
 *
 *  A. Wikipedia, "March equinox",
 *     https://en.wikipedia.org/wiki/March_equinox (astronomical almanac data
 *     table): March equinox 2024 = March 20, 2024, 03:07 UTC -- the Sun's
 *     geocentric tropical ecliptic longitude crosses 360deg -> 0deg
 *     (Pisces -> Aries).
 *
 *  B. Cafe Astrology dated event pages (a published retrograde calendar):
 *     - https://cafeastrology.com/events/mercury-turns-retrograde-aries-2024/
 *       Mercury stations retrograde 2024-04-01T22:14Z at 27deg13' Aries
 *       (27.217deg).
 *     - https://cafeastrology.com/events/mercury-turns-direct-aries-2024/
 *       Mercury stations direct 2024-04-25T12:54Z at 15deg59' Aries
 *       (15.983deg). Mercury's longitude moved monotonically backward from
 *       27.217deg to 15.983deg over the whole cycle, entirely within Aries
 *       [0,30) -- it never left Aries during this retrograde period.
 *     - https://cafeastrology.com/events/mercury-enters-virgo-july-2024/
 *       Mercury (direct/forward motion) crosses Leo -> Virgo, entering
 *       Virgo, on 2024-07-25T22:41Z.
 *     - https://cafeastrology.com/events/mercury-turns-retrograde-in-virgo-2024/
 *       Mercury stations retrograde 2024-08-05T08:00Z at 4deg07' Virgo
 *       (~124.117deg).
 *     - https://cafeastrology.com/events/mercury-turns-direct-in-leo-2024/
 *       Mercury stations direct 2024-08-28T21:14Z at 21deg24' Leo
 *       (~141.4deg). (Not used directly below; included in the brief for
 *       completeness of the cycle.)
 */
import { describe, expect, it } from "vitest";
import { computeNatalChart } from "./natal";
import { computeTransitChart } from "./sky";

describe("Mercury retrograde + sign against a published retrograde calendar (Source B)", () => {
  it("2024-04-10: well inside the Apr1-Apr25 Aries retrograde window -> retrograde, sign Aries", () => {
    // Source B: retrograde station 2024-04-01T22:14Z at 27.217deg Aries;
    // direct station 2024-04-25T12:54Z at 15.983deg Aries. 2024-04-10 sits
    // ~9 days after the retrograde station and ~15 days before the direct
    // station -- comfortably inside the window, far from both stations, and
    // the whole cycle stayed within Aries bounds (27.217 -> 15.983, never
    // leaving [0,30)), so the sign assertion is safe for any date strictly
    // between the two stations.
    const chart = computeTransitChart(new Date("2024-04-10T00:00:00Z"));
    expect(chart.bodies.Mercury.retrograde).toBe(true);
    expect(chart.bodies.Mercury.sign).toBe("Aries");
  });

  it("2024-04-26: one full day after the Apr 25 12:54Z direct station -> direct, sign still Aries", () => {
    // Source B: direct station 2024-04-25T12:54Z at 15.983deg Aries, moving
    // forward from there. 2024-04-26T00:00Z is ~11h15m after the station --
    // comfortably clear of the turn itself, so there is no ambiguity about
    // which side of the station this instant is on. Forward motion from
    // 15.983deg Aries over roughly a day covers well under 2deg, nowhere
    // near the 30deg Taurus boundary, so the sign stays Aries.
    const chart = computeTransitChart(new Date("2024-04-26T00:00:00Z"));
    expect(chart.bodies.Mercury.retrograde).toBe(false);
    expect(chart.bodies.Mercury.sign).toBe("Aries");
  });

  it("2024-07-26: about a day after the Jul 25 22:41Z forward ingress into Virgo -> direct, sign Virgo", () => {
    // Source B: Mercury (direct/forward motion) crosses Leo -> Virgo at
    // 2024-07-25T22:41Z. 2024-07-26T00:00Z is ~1h19m after the ingress --
    // just crossed into Virgo and moving forward, well before the next
    // retrograde station (2024-08-05T08:00Z, more than a week later), so
    // there's no chance this instant is still retrograde or has slipped
    // back into Leo.
    const chart = computeTransitChart(new Date("2024-07-26T00:00:00Z"));
    expect(chart.bodies.Mercury.retrograde).toBe(false);
    expect(chart.bodies.Mercury.sign).toBe("Virgo");
  });

  it("2024-08-06: about 16h after the Aug 5 08:00Z retrograde station -> retrograde, sign still Virgo", () => {
    // Source B: retrograde station 2024-08-05T08:00Z at 4.117deg Virgo
    // (4deg07'). 2024-08-06T00:00Z is ~16h after the station -- Mercury has
    // only just started moving backward and, at a typical retrograde speed
    // of roughly 1deg/day, has regressed well under 1deg from 4.117deg,
    // nowhere close to the 0deg Leo boundary. Clearly retrograde and still
    // in Virgo.
    const chart = computeTransitChart(new Date("2024-08-06T00:00:00Z"));
    expect(chart.bodies.Mercury.retrograde).toBe(true);
    expect(chart.bodies.Mercury.sign).toBe("Virgo");
  });
});

describe("Pisces -> Aries wraparound on a real ephemeris crossing (Source A, the March 2024 equinox)", () => {
  // Distinct from oracle-6g3's synthetic wraparound tests in sky.test.ts
  // (which use hand-picked longitudes like 359.5/360/0.5, not a real date).
  // This test isolates the sign/wraparound math on the Sun specifically
  // because the Sun is never flagged retrograde, so there's no retrograde
  // logic to confound the sign check.

  it("2024-03-19T12:00Z: well before the 03:07Z Mar 20 equinox -> Sun still Pisces, high-350s longitude", () => {
    // Source A: equinox (360deg->0deg crossing) at 2024-03-20T03:07Z. This
    // instant is ~15h before the crossing, safely on the Pisces side.
    const chart = computeTransitChart(new Date("2024-03-19T12:00:00Z"));
    expect(chart.bodies.Sun.sign).toBe("Pisces");
    expect(chart.bodies.Sun.longitude).toBeGreaterThan(350);
    expect(chart.bodies.Sun.longitude).toBeLessThan(360);
  });

  it("2024-03-21T12:00Z: well after the 03:07Z Mar 20 equinox -> Sun now Aries, low-single-digit longitude", () => {
    // Source A: equinox at 2024-03-20T03:07Z. This instant is ~33h after the
    // crossing, safely on the Aries side -- the Sun moves about 1deg/day, so
    // ~33h out corresponds to roughly 1.4deg past 0deg, comfortably inside
    // Aries and far from re-approaching either boundary.
    const chart = computeTransitChart(new Date("2024-03-21T12:00:00Z"));
    expect(chart.bodies.Sun.sign).toBe("Aries");
    expect(chart.bodies.Sun.longitude).toBeGreaterThanOrEqual(0);
    expect(chart.bodies.Sun.longitude).toBeLessThan(10);
  });
});

describe("Sun cusp-day ambiguity, a real precisely-sourced case (Source A, the March 2024 equinox)", () => {
  it("birthdate 2024-03-20 (equinox day), no time given, utcOffsetMinutes 0 -> Sun ambiguous: true", () => {
    // Source A: the equinox (Sun's Pisces->Aries sign change) happens at
    // 2024-03-20T03:07Z, strictly between local midnight
    // (2024-03-20T00:00Z, Sun still Pisces) and local midnight+24h
    // (2024-03-21T00:00Z, Sun already Aries) for utcOffsetMinutes: 0 (which
    // matches the citation, itself given in UTC). This is exactly the kind
    // of "Sun cusp day" the spec calls out (docs/spec.md section 1: "flag
    // any body that changes sign during that day as ambiguous: true...this
    // covers Sun cusp days"), verified against a real published equinox
    // instant rather than invented.
    const chart = computeNatalChart({
      date: { year: 2024, month: 3, day: 20 },
      utcOffsetMinutes: 0,
    });
    expect(chart.timeKnown).toBe(false);
    expect(chart.bodies.Sun.ambiguous).toBe(true);
  });
});
