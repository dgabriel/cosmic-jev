import { describe, expect, it } from "vitest";
import {
  angularSeparation,
  ASPECT_ANGLES,
  ASPECT_ORBS,
  aspectForSeparation,
  computeAspects,
  isApplying,
  type Aspect,
} from "./aspects";
import {
  positionForBody,
  signForLongitude,
  TRANSIT_BODIES,
  type BodyPosition,
  type TransitBodyName,
  type TransitChart,
} from "./sky";
import type { NatalBodyPosition, NatalChart } from "./natal";

// NOTE: like sky.test.ts and natal.test.ts, these tests cover
// mechanical/structural behavior only (orb boundaries, wraparound math, the
// applying/separating direction rule, and the ambiguity-gating mechanism)
// using synthetic/hand-constructed longitudes and charts. They do NOT assert
// that any real transiting body aspects any real natal Sun/Moon on any real
// date as a "verified" ground truth.

describe("angularSeparation", () => {
  it("reads two longitudes straddling the 360/0 seam as close together", () => {
    expect(angularSeparation(359, 1)).toBe(2);
    expect(angularSeparation(1, 359)).toBe(2);
  });

  it("returns the plain difference when nowhere near the seam", () => {
    expect(angularSeparation(100, 40)).toBe(60);
    expect(angularSeparation(40, 100)).toBe(60);
  });

  it("returns 180 for exact opposition regardless of direction", () => {
    expect(angularSeparation(0, 180)).toBe(180);
    expect(angularSeparation(180, 0)).toBe(180);
  });
});

describe("aspectForSeparation", () => {
  it("detects each aspect type at its exact angle", () => {
    expect(aspectForSeparation(0)).toEqual({ aspect: "conjunction", orb: 0 });
    expect(aspectForSeparation(60)).toEqual({ aspect: "sextile", orb: 0 });
    expect(aspectForSeparation(90)).toEqual({ aspect: "square", orb: 0 });
    expect(aspectForSeparation(120)).toEqual({ aspect: "trine", orb: 0 });
    expect(aspectForSeparation(180)).toEqual({ aspect: "opposition", orb: 0 });
  });

  it("includes the boundary exactly at each aspect's orb (inclusive)", () => {
    for (const aspect of Object.keys(ASPECT_ANGLES) as (keyof typeof ASPECT_ANGLES)[]) {
      const angle = ASPECT_ANGLES[aspect];
      const orb = ASPECT_ORBS[aspect];
      // Approach from whichever side keeps the separation within [0, 180].
      const boundary = angle + orb <= 180 ? angle + orb : angle - orb;
      expect(aspectForSeparation(boundary)).toEqual({ aspect, orb });
    }
  });

  it("excludes a separation just outside each aspect's orb", () => {
    for (const aspect of Object.keys(ASPECT_ANGLES) as (keyof typeof ASPECT_ANGLES)[]) {
      const angle = ASPECT_ANGLES[aspect];
      const orb = ASPECT_ORBS[aspect];
      const justOutside = angle + orb + 0.01 <= 180 ? angle + orb + 0.01 : angle - orb - 0.01;
      const match = aspectForSeparation(justOutside);
      // It must not match *this* aspect (it may or may not match a
      // neighboring one, but neighbors are >= 60 degrees away and every orb
      // is well under half that, so in practice it matches nothing).
      expect(match?.aspect).not.toBe(aspect);
    }
  });

  it("returns null for a separation in the gap between two aspect angles", () => {
    // Halfway between conjunction (0) and sextile (60): 30 degrees, far
    // outside both of their orbs (3 and 1).
    expect(aspectForSeparation(30)).toBeNull();
  });

  it("detects a conjunction from a separation produced by the 360/0 wraparound", () => {
    // 359 and 1 are 2 degrees apart (via angularSeparation), well within the
    // conjunction orb of 3.
    const separation = angularSeparation(359, 1);
    expect(aspectForSeparation(separation)).toEqual({ aspect: "conjunction", orb: 2 });
  });
});

describe("isApplying", () => {
  it("is true when the orb shrinks (moving toward exact)", () => {
    expect(isApplying(3, 2)).toBe(true);
  });

  it("is false when the orb grows (moving away from exact)", () => {
    expect(isApplying(2, 3)).toBe(false);
  });

  it("is false when the orb is unchanged (treated as separating, not applying)", () => {
    expect(isApplying(2, 2)).toBe(false);
  });
});

/** Builds a synthetic (not ephemeris-derived) BodyPosition at an arbitrary longitude. */
function makeBodyPosition(body: BodyPosition["body"], longitude: number): BodyPosition {
  const { sign, degreeInSign } = signForLongitude(longitude);
  return { body, longitude, sign, degreeInSign, retrograde: false };
}

/** Builds a synthetic NatalBodyPosition at an arbitrary longitude. */
function makeNatalBodyPosition(
  body: BodyPosition["body"],
  longitude: number,
  ambiguous: boolean,
): NatalBodyPosition {
  return { ...makeBodyPosition(body, longitude), ambiguous };
}

describe("computeAspects", () => {
  // Fixed, arbitrary "now" instant for the synthetic transit chart -- not
  // asserted against any reference ephemeris; only used so `computeAspects`
  // has a real date to fetch a real +24h later position from (for the
  // applying/separating wiring check below).
  const transitDate = new Date("2024-06-01T00:00:00Z");

  const natalSunLongitude = 0;
  const natalMoonLongitude = 133;

  // Hand-picked synthetic transit longitudes, chosen so each demonstrates a
  // different aspect type/target and a couple demonstrate "no aspect at
  // all" -- see the accompanying comment on each for the arithmetic.
  const transitLongitudes: Record<(typeof TRANSIT_BODIES)[number], number> = {
    Sun: 3, // conjunction to natal Sun, orb 3 (exact boundary)
    Moon: 200, // no aspect to either natal point
    Mercury: 90.5, // square to natal Sun, orb 0.5
    Venus: 359, // conjunction to natal Sun via the 360/0 wraparound, orb 1
    Mars: natalMoonLongitude + 120, // trine to natal Moon, exact
    Jupiter: natalMoonLongitude + 180, // opposition to natal Moon, exact
    Saturn: 61, // sextile to natal Sun, orb 1 (exact boundary)
  };

  function buildTransitChart(): TransitChart {
    const bodies = Object.fromEntries(
      TRANSIT_BODIES.map((body) => [body, makeBodyPosition(body, transitLongitudes[body])]),
    ) as TransitChart["bodies"];
    return { date: transitDate, bodies, moonPhaseAngle: 0, moonPhase: "new" };
  }

  function buildNatalChart(moonAmbiguous: boolean): NatalChart {
    const bodies = Object.fromEntries(
      TRANSIT_BODIES.map((body) => {
        const longitude =
          body === "Sun" ? natalSunLongitude : body === "Moon" ? natalMoonLongitude : 47 + 13 * TRANSIT_BODIES.indexOf(body);
        const ambiguous = body === "Moon" ? moonAmbiguous : false;
        return [body, makeNatalBodyPosition(body, longitude, ambiguous)];
      }),
    ) as NatalChart["bodies"];
    return {
      input: { date: { year: 2024, month: 1, day: 1 } },
      instant: new Date("2024-01-01T12:00:00Z"),
      timeKnown: false,
      bodies,
      ascendant: { status: "not-computed" },
    };
  }

  function findAspect(aspects: Aspect[], transit: string, natal: string): Aspect | undefined {
    return aspects.find((a) => a.transit === transit && a.natal === natal);
  }

  it("returns only the aspects actually within orb, not a full transit x natal-point cross-product", () => {
    const aspects = computeAspects(buildTransitChart(), buildNatalChart(false));

    // 7 transiting bodies x 2 natal points = 14 possible pairs; only the
    // hand-picked ones above should be within orb.
    expect(aspects.length).toBe(6);

    expect(findAspect(aspects, "Sun", "Sun")).toMatchObject({ aspect: "conjunction", orb: 3 });
    expect(findAspect(aspects, "Mercury", "Sun")).toMatchObject({ aspect: "square", orb: 0.5 });
    expect(findAspect(aspects, "Venus", "Sun")).toMatchObject({ aspect: "conjunction", orb: 1 });
    expect(findAspect(aspects, "Saturn", "Sun")).toMatchObject({ aspect: "sextile", orb: 1 });
    expect(findAspect(aspects, "Mars", "Moon")).toMatchObject({ aspect: "trine", orb: 0 });
    expect(findAspect(aspects, "Jupiter", "Moon")).toMatchObject({ aspect: "opposition", orb: 0 });

    // Moon and Saturn... wait Saturn aspects Sun above; transiting Moon has
    // no aspect to either natal point in this synthetic chart.
    expect(findAspect(aspects, "Moon", "Sun")).toBeUndefined();
    expect(findAspect(aspects, "Moon", "Moon")).toBeUndefined();
  });

  it("excludes natal Moon aspects when the natal Moon is ambiguous, but keeps natal Sun aspects", () => {
    const aspects = computeAspects(buildTransitChart(), buildNatalChart(true));

    expect(aspects.every((a) => a.natal === "Sun")).toBe(true);
    expect(findAspect(aspects, "Mars", "Moon")).toBeUndefined();
    expect(findAspect(aspects, "Jupiter", "Moon")).toBeUndefined();
    expect(findAspect(aspects, "Sun", "Sun")).toBeDefined();
    expect(findAspect(aspects, "Mercury", "Sun")).toBeDefined();
  });

  it("includes natal Moon aspects when the natal Moon is not ambiguous", () => {
    const aspects = computeAspects(buildTransitChart(), buildNatalChart(false));
    expect(findAspect(aspects, "Mars", "Moon")).toBeDefined();
    expect(findAspect(aspects, "Jupiter", "Moon")).toBeDefined();
  });

  it("wires the applying/separating check to the same +24h comparison the module documents (cross-check, not a hardcoded ephemeris value)", () => {
    const transits = buildTransitChart();
    const natal = buildNatalChart(false);
    const aspects = computeAspects(transits, natal);
    const sunAspect = findAspect(aspects, "Sun", "Sun");
    expect(sunAspect).toBeDefined();

    // Independently recompute the expected `applying` value the same way
    // computeAspects documents doing it: fetch the real body position 24h
    // later and compare orbs. This cross-checks the wiring (not the
    // ephemeris itself, which is exercised elsewhere).
    const later = new Date(transits.date.getTime() + 24 * 60 * 60 * 1000);
    const laterLongitude = positionForBody("Sun", later).longitude;
    const laterSeparation = angularSeparation(laterLongitude, natalSunLongitude);
    const laterOrb = Math.abs(laterSeparation - ASPECT_ANGLES.conjunction);
    const expectedApplying = isApplying(sunAspect!.orb, laterOrb);

    expect(sunAspect!.applying).toBe(expectedApplying);
  });

  it("returns aspects in canonical TRANSIT_BODIES order, regardless of the input chart's own key-insertion order", () => {
    // Deliberately build `bodies` with a key-insertion order that is the
    // *reverse* of TRANSIT_BODIES (rather than reusing `buildTransitChart`,
    // which happens to insert keys in TRANSIT_BODIES order already and so
    // would not catch a regression to `Object.keys(transits.bodies)`).
    const reverseOrder = [...TRANSIT_BODIES].reverse() as TransitBodyName[];
    const shuffledBodies = {} as TransitChart["bodies"];
    for (const body of reverseOrder) {
      shuffledBodies[body] = makeBodyPosition(body, transitLongitudes[body]);
    }
    expect(Object.keys(shuffledBodies)).toEqual(reverseOrder);

    const shuffledTransits: TransitChart = {
      date: transitDate,
      bodies: shuffledBodies,
      moonPhaseAngle: 0,
      moonPhase: "new",
    };

    const aspects = computeAspects(shuffledTransits, buildNatalChart(false));

    // Per the hand-picked longitudes above: Sun, Mercury, Venus, and Saturn
    // aspect the natal Sun; Mars and Jupiter aspect the natal Moon; Moon
    // aspects nothing. Expected order is TRANSIT_BODIES's order with Moon
    // filtered out, not the reversed insertion order used above.
    expect(aspects.map((a) => a.transit)).toEqual(["Sun", "Mercury", "Venus", "Mars", "Jupiter", "Saturn"]);
  });
});
