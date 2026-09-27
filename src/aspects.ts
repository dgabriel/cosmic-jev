/**
 * Aspects (oracle-47m): transiting bodies to the natal Sun (always) and the
 * natal Moon (only when its natal position is not ambiguous, per spec).
 *
 * Reuses sky.ts's `normalizeLongitudeDelta` (the same 360->0 wraparound
 * helper `isRetrograde` uses) and `positionForBody`, and natal.ts's
 * `NatalChart`/`NatalBodyPosition`, rather than re-implementing any of that
 * math. Pure, no I/O beyond the ephemeris calls already used elsewhere:
 * everything needed (the transit chart and the natal chart) is passed in by
 * the caller.
 */
import {
  normalizeLongitudeDelta,
  positionForBody,
  TRANSIT_BODIES,
  type TransitBodyName,
  type TransitChart,
} from "./sky";
import type { NatalChart } from "./natal";

export const ASPECT_TYPES = ["conjunction", "sextile", "square", "trine", "opposition"] as const;

export type AspectType = (typeof ASPECT_TYPES)[number];

/** The only two natal points aspects are computed against (per spec). */
export const NATAL_POINTS = ["Sun", "Moon"] as const;

export type NatalPoint = (typeof NATAL_POINTS)[number];

export interface Aspect {
  transit: TransitBodyName;
  natal: NatalPoint;
  aspect: AspectType;
  /** Absolute degrees from the exact aspect angle (always <= that aspect's orb). */
  orb: number;
  /** True if the transit is moving toward exact (the orb is shrinking over the next 24h). */
  applying: boolean;
}

/** Exact angular separation, in degrees, that defines each aspect type. */
export const ASPECT_ANGLES: Record<AspectType, number> = {
  conjunction: 0,
  sextile: 60,
  square: 90,
  trine: 120,
  opposition: 180,
};

/**
 * Orbs (allowed tolerance either side of the exact angle), one per aspect
 * type, applied uniformly across all transiting bodies.
 *
 * These are transit-to-natal-*point* orbs, not natal-to-natal orbs. A
 * moving transiting body vs. a single fixed natal point is conventionally
 * read with a *tighter* tolerance than an aspect between two (both fixed)
 * natal points: with a wide natal-chart-sized orb, a fast body like the
 * Moon or Mercury would read as "in aspect" for days at a stretch, which
 * would swamp the ruling-body-specific aspect list the oracle's Call 2
 * consumes (spec: "relevant aspect list"). Within that tighter
 * transit-to-natal band, this still keeps the conventional *shape* of a
 * classic natal orb table: the "major axis" aspects (conjunction and
 * opposition -- the body sitting on or exactly across from the natal
 * point) get the widest orb, square and trine (the other classic "major"
 * aspects) get a middling orb, and the sextile (traditionally read as the
 * softest/weakest of the five) gets the tightest orb.
 *
 *   conjunction / opposition: 3 degrees
 *   square / trine:           2 degrees
 *   sextile:                  1 degree
 *
 * (Every aspect angle -- 0, 60, 90, 120, 180 -- is at least 60 degrees from
 * its neighbors, so these orbs are all well under half that spacing and
 * can never overlap into ambiguity between two aspect types.)
 */
export const ASPECT_ORBS: Record<AspectType, number> = {
  conjunction: 3,
  opposition: 3,
  square: 2,
  trine: 2,
  sextile: 1,
};

const TWENTY_FOUR_HOURS_MILLIS = 24 * 60 * 60 * 1000;

/**
 * Angular separation between two ecliptic longitudes, in [0, 180]: "how far
 * apart" two bodies/points are, for comparing against the aspect angles
 * (0/60/90/120/180). Reuses `normalizeLongitudeDelta` (sky.ts's 360->0
 * wraparound helper) so a pair of longitudes straddling the 360/0 seam
 * (e.g. 359 and 1) correctly reads as 2 degrees apart, not 358.
 */
export function angularSeparation(lonA: number, lonB: number): number {
  return Math.abs(normalizeLongitudeDelta(lonA - lonB));
}

/**
 * Finds the (at most one) aspect type whose orb contains `separation`, or
 * `null` if none does. At most one can match: the five aspect angles are
 * each at least 60 degrees apart and every orb above is well under half
 * that gap (see `ASPECT_ORBS`'s comment).
 */
export function aspectForSeparation(separation: number): { aspect: AspectType; orb: number } | null {
  for (const aspect of ASPECT_TYPES) {
    const orb = Math.abs(separation - ASPECT_ANGLES[aspect]);
    if (orb <= ASPECT_ORBS[aspect]) {
      return { aspect, orb };
    }
  }
  return null;
}

/**
 * Whether an aspect is applying (moving toward exact) given its orb now and
 * its orb a short time later, rather than inferring direction from the
 * transiting body's retrograde status. This mirrors sky.ts's
 * `isRetrograde` in *spirit* (a before/after comparison across a short
 * interval, +24h below) but compares "is the orb shrinking" rather than
 * "is the longitude decreasing": an aspect can tighten while its body is
 * retrograde (approaching from the other side) just as easily as while
 * prograde, so orb motion -- not raw longitude direction -- is the right
 * signal here.
 *
 * Exported as a pure function, independent of any ephemeris call, so its
 * boundary behavior (applying vs. separating vs. exactly stationary) can be
 * unit-tested directly with synthetic orb values.
 */
export function isApplying(orbNow: number, orbLater: number): boolean {
  return orbLater < orbNow;
}

/**
 * Computes aspects from every transiting body (in `transits`) to the natal
 * Sun, and to the natal Moon only when the natal Moon's position is not
 * flagged `ambiguous` (per spec: without a birth time, an uncertain natal
 * Moon position shouldn't be reported as a confident aspect target). Only
 * returns aspects that are actually within orb -- a "clean list", not a
 * full cross-product of every transit x natal-point pair regardless of orb.
 *
 * `applying` is computed the same way `isRetrograde` determines direction
 * in sky.ts: compare against the same body's position 24h later (handling
 * the 360->0 wraparound via `normalizeLongitudeDelta`/`angularSeparation`),
 * but here comparing the resulting orb rather than raw longitude -- see
 * `isApplying`'s doc comment for why.
 *
 * Iterates the canonical `TRANSIT_BODIES` order (the same fixed order
 * sky.ts and natal.ts both iterate for their own body records) rather than
 * `Object.keys(transits.bodies)`: the output order must not depend on the
 * caller's `TransitChart.bodies` object's own key-insertion order, which
 * isn't something this function's input type guarantees.
 */
export function computeAspects(transits: TransitChart, natal: NatalChart): Aspect[] {
  const natalPoints: NatalPoint[] = natal.bodies.Moon.ambiguous ? ["Sun"] : ["Sun", "Moon"];
  const later = new Date(transits.date.getTime() + TWENTY_FOUR_HOURS_MILLIS);

  const aspects: Aspect[] = [];
  for (const transitBody of TRANSIT_BODIES) {
    const transitLongitudeNow = transits.bodies[transitBody].longitude;

    for (const natalPoint of natalPoints) {
      const natalLongitude = natal.bodies[natalPoint].longitude;
      const separationNow = angularSeparation(transitLongitudeNow, natalLongitude);
      const match = aspectForSeparation(separationNow);
      if (!match) continue;

      const transitLongitudeLater = positionForBody(transitBody, later).longitude;
      const separationLater = angularSeparation(transitLongitudeLater, natalLongitude);
      const orbLater = Math.abs(separationLater - ASPECT_ANGLES[match.aspect]);

      aspects.push({
        transit: transitBody,
        natal: natalPoint,
        aspect: match.aspect,
        orb: match.orb,
        applying: isApplying(match.orb, orbLater),
      });
    }
  }
  return aspects;
}
