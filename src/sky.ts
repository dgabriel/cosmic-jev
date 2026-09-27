/**
 * Astronomy module: transit chart only (oracle-6g3).
 *
 * Pure, typed, no I/O. The `date` for "now" is always passed in by the
 * caller; nothing here reads the system clock.
 *
 * Natal chart (with cusp ambiguity / optional Ascendant) lives in
 * ./natal.ts (bd oracle-55h), which reuses `positionForBody`,
 * `normalizeDegrees`, `signForLongitude`, `TRANSIT_BODIES`, and the body
 * position/sign types exported here. Aspect computation (oracle-47m) is a
 * separate concern and is intentionally NOT implemented in this module.
 */
import * as Astronomy from "astronomy-engine";

/** The seven traditional bodies used throughout the app. */
export const TRANSIT_BODIES = [
  "Sun",
  "Moon",
  "Mercury",
  "Venus",
  "Mars",
  "Jupiter",
  "Saturn",
] as const;

export type TransitBodyName = (typeof TRANSIT_BODIES)[number];

/** Maps our body names onto astronomy-engine's `Body` enum. */
const ASTRONOMY_BODY: Record<TransitBodyName, Astronomy.Body> = {
  Sun: Astronomy.Body.Sun,
  Moon: Astronomy.Body.Moon,
  Mercury: Astronomy.Body.Mercury,
  Venus: Astronomy.Body.Venus,
  Mars: Astronomy.Body.Mars,
  Jupiter: Astronomy.Body.Jupiter,
  Saturn: Astronomy.Body.Saturn,
};

/** Bodies whose apparent retrograde motion is never reported (spec: never retrograde). */
const NEVER_RETROGRADE: ReadonlySet<TransitBodyName> = new Set(["Sun", "Moon"]);

export const ZODIAC_SIGNS = [
  "Aries",
  "Taurus",
  "Gemini",
  "Cancer",
  "Leo",
  "Virgo",
  "Libra",
  "Scorpio",
  "Sagittarius",
  "Capricorn",
  "Aquarius",
  "Pisces",
] as const;

export type Sign = (typeof ZODIAC_SIGNS)[number];

export interface SignPosition {
  sign: Sign;
  /** Degree within the sign, in [0, 30). */
  degreeInSign: number;
}

/** Position for a single body in the transit chart. */
export interface BodyPosition {
  body: TransitBodyName;
  /** Geocentric tropical ecliptic longitude of date, in [0, 360). */
  longitude: number;
  sign: Sign;
  /** Degree within the sign, in [0, 30). */
  degreeInSign: number;
  retrograde: boolean;
}

export const MOON_PHASE_NAMES = [
  "new",
  "waxing crescent",
  "first quarter",
  "waxing gibbous",
  "full",
  "waning gibbous",
  "last quarter",
  "waning crescent",
] as const;

export type MoonPhaseName = (typeof MOON_PHASE_NAMES)[number];

export interface TransitChart {
  date: Date;
  bodies: Record<TransitBodyName, BodyPosition>;
  /** Sun-Moon ecliptic longitude difference in [0, 360), per Astronomy.MoonPhase. */
  moonPhaseAngle: number;
  moonPhase: MoonPhaseName;
}

/**
 * Normalizes an angle to [0, 360).
 *
 * Exported so natal.ts (oracle-55h) can reuse it (e.g. for normalizing the
 * Ascendant longitude) instead of re-implementing the same modulo logic.
 */
export function normalizeDegrees(angle: number): number {
  const wrapped = angle % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/**
 * Normalizes a longitude delta to (-180, 180], so that a naive subtraction
 * across the 360deg -> 0deg wraparound (e.g. 359deg -> 1deg) reads as a small
 * positive step (+2deg) rather than a huge negative jump (-358deg).
 *
 * Exported for unit testing the wraparound math directly with synthetic
 * values (see sky.test.ts); it is also used internally by `isRetrograde`.
 */
export function normalizeLongitudeDelta(delta: number): number {
  let d = delta % 360;
  if (d <= -180) d += 360;
  if (d > 180) d -= 360;
  return d;
}

/** Splits a longitude in [0, 360) into a zodiac sign and degree-in-sign. */
export function signForLongitude(longitude: number): SignPosition {
  const normalized = normalizeDegrees(longitude);
  const index = Math.floor(normalized / 30);
  // index is guaranteed to be 0..11 since normalized is in [0, 360).
  const sign = ZODIAC_SIGNS[index] as Sign;
  const degreeInSign = normalized - index * 30;
  return { sign, degreeInSign };
}

/** Geocentric tropical ecliptic longitude of date for a body, in [0, 360). */
function eclipticLongitudeOfDate(body: Astronomy.Body, date: Date): number {
  const vector = Astronomy.GeoVector(body, date, true);
  return normalizeDegrees(Astronomy.Ecliptic(vector).elon);
}

/**
 * Retrograde status by comparing longitude at `date` against `date + 24h`.
 * Sun and Moon are hardcoded as never retrograde per spec (their apparent
 * motion can read as near-zero/ambiguous around stationary points, and the
 * spec says to never flag them regardless).
 */
function isRetrograde(bodyName: TransitBodyName, astronomyBody: Astronomy.Body, date: Date): boolean {
  if (NEVER_RETROGRADE.has(bodyName)) {
    return false;
  }
  const lonNow = eclipticLongitudeOfDate(astronomyBody, date);
  const later = new Date(date.getTime() + 24 * 60 * 60 * 1000);
  const lonLater = eclipticLongitudeOfDate(astronomyBody, later);
  const delta = normalizeLongitudeDelta(lonLater - lonNow);
  // Normal (prograde) apparent motion increases ecliptic longitude over time.
  // A negative normalized delta means the body appears to move backwards.
  return delta < 0;
}

/**
 * Computes a single body's position (longitude, sign, degree, retrograde) at
 * an arbitrary instant.
 *
 * Exported so natal.ts (oracle-55h) can reuse this exact astronomy call for
 * natal body positions and for the natal day-boundary ambiguity check,
 * instead of re-implementing the GeoVector/Ecliptic/retrograde math.
 */
export function positionForBody(bodyName: TransitBodyName, date: Date): BodyPosition {
  const astronomyBody = ASTRONOMY_BODY[bodyName];
  const longitude = eclipticLongitudeOfDate(astronomyBody, date);
  const { sign, degreeInSign } = signForLongitude(longitude);
  return {
    body: bodyName,
    longitude,
    sign,
    degreeInSign,
    retrograde: isRetrograde(bodyName, astronomyBody, date),
  };
}

/**
 * Names the Moon's phase from its phase angle (Sun-Moon ecliptic longitude
 * difference, per `Astronomy.MoonPhase`: 0 = new, 90 = first quarter,
 * 180 = full, 270 = third/last quarter).
 *
 * Boundaries follow the conventional 8-phase split: each named phase spans
 * a 45deg arc centered on its cardinal angle (so "new" is [337.5, 360) union
 * [0, 22.5), "first quarter" is [67.5, 112.5), etc).
 */
export function moonPhaseName(phaseAngle: number): MoonPhaseName {
  const angle = normalizeDegrees(phaseAngle);
  if (angle < 22.5 || angle >= 337.5) return "new";
  if (angle < 67.5) return "waxing crescent";
  if (angle < 112.5) return "first quarter";
  if (angle < 157.5) return "waxing gibbous";
  if (angle < 202.5) return "full";
  if (angle < 247.5) return "waning gibbous";
  if (angle < 292.5) return "last quarter";
  return "waning crescent";
}

/** Computes the full transit chart (current planetary positions) for `date`. */
export function computeTransitChart(date: Date): TransitChart {
  const bodies = Object.fromEntries(
    TRANSIT_BODIES.map((bodyName) => [bodyName, positionForBody(bodyName, date)]),
  ) as Record<TransitBodyName, BodyPosition>;

  const moonPhaseAngle = normalizeDegrees(Astronomy.MoonPhase(date));

  return {
    date,
    bodies,
    moonPhaseAngle,
    moonPhase: moonPhaseName(moonPhaseAngle),
  };
}
