/**
 * Natal chart (oracle-55h): birthdate/time/location -> body positions, cusp
 * ambiguity, and an optional Ascendant.
 *
 * Reuses sky.ts's transit-chart building blocks (`TRANSIT_BODIES`,
 * `positionForBody`, `signForLongitude`, `normalizeDegrees`, `Sign`,
 * `BodyPosition`) rather than re-implementing the ephemeris math. Pure, no
 * I/O: the caller supplies the birth data, nothing here reads a clock.
 *
 * ---
 * DESIGN DECISION FLAGGED FOR CONFIRMATION (timezone source):
 *
 * The spec requires "local noon" for the no-birth-time case and needs a
 * UTC offset to convert a given birth *clock* time to an absolute instant.
 * Neither docs/spec.md nor the oracle-55h issue says where that UTC offset
 * comes from -- the app has no timezone database or geocoding lookup (and
 * adding one would be a new dependency, which needs sign-off first per
 * project rules). So this module takes `utcOffsetMinutes` as an explicit,
 * optional field on `BirthInput`:
 *   - If provided, it is trusted as-is (e.g. a UI timezone/offset picker).
 *   - If omitted, THIS MODULE DEFAULTS IT TO 0 (UTC), i.e. it treats the
 *     given birthdate/time as if it were already UTC. This is almost
 *     certainly wrong for a real birth location, but it is a deterministic,
 *     documented fallback rather than a silent guess buried in the code.
 * Flagging this explicitly: please confirm whether UTC-when-unknown is the
 * right fallback, or whether the UI should require an offset (or derive one
 * from a location, which would need a new dependency) before this ships.
 * ---
 */
import * as Astronomy from "astronomy-engine";
import {
  type BodyPosition,
  type Sign,
  TRANSIT_BODIES,
  type TransitBodyName,
  normalizeDegrees,
  positionForBody,
  signForLongitude,
} from "./sky";

/** A calendar birthdate. `month` is 1-12 (not zero-based), in local terms. */
export interface BirthDate {
  year: number;
  /** 1 (January) to 12 (December). */
  month: number;
  day: number;
}

/** A birth clock time, in the birth location's local time. 24-hour clock. */
export interface BirthTime {
  /** 0-23. */
  hour: number;
  /** 0-59. */
  minute: number;
}

/** Geographic birth location, needed for local-noon math and the Ascendant. */
export interface BirthLocation {
  /** Degrees north of the equator; negative is south. Range [-90, 90]. */
  latitude: number;
  /** Degrees east of Greenwich; negative is west. Range [-180, 180]. */
  longitude: number;
}

/**
 * Typed input for a natal chart. Only `date` is required, per spec.
 *
 * See the module-level comment above for the flagged `utcOffsetMinutes`
 * design decision: it is optional and defaults to 0 (UTC) when absent.
 */
export interface BirthInput {
  date: BirthDate;
  time?: BirthTime;
  location?: BirthLocation;
  /**
   * UTC offset in minutes for `date`/`time` (e.g. -300 for US Eastern
   * Standard Time, +330 for India Standard Time). Optional; defaults to 0
   * (UTC) when omitted -- see the flagged design decision above.
   */
  utcOffsetMinutes?: number;
}

/** A natal body position, extending the transit `BodyPosition` shape. */
export interface NatalBodyPosition extends BodyPosition {
  /**
   * True if this body's sign is not certain given the available birth data:
   * only ever set when no birth time was given, and only for a body whose
   * sign differs between the start and end of the birthdate (local time).
   * Always false when an exact birth time is known.
   */
  ambiguous: boolean;
}

/** The Ascendant (rising sign): only computed when both time and location are known. */
export interface AscendantPosition {
  /** Geocentric tropical ecliptic longitude of date, in [0, 360). */
  longitude: number;
  sign: Sign;
  /** Degree within the sign, in [0, 30). */
  degreeInSign: number;
}

/**
 * Result of trying to compute the Ascendant. A plain `AscendantPosition | null`
 * would let a caller silently treat "we didn't try" (missing time/location)
 * the same as "we tried and it's numerically unreliable" -- both would just
 * read as falsy. This discriminated union forces callers to handle all three
 * cases explicitly:
 *  - `"not-computed"`: birth time and/or location were not given.
 *  - `"unreliable"`: both were given, but the result should not be trusted
 *    (see `computeAscendant`'s doc comment for why); `reason` is a
 *    human-readable explanation suitable for surfacing to the user.
 *  - `"ok"`: both were given and the result is numerically reliable.
 */
export type AscendantResult =
  | { status: "not-computed" }
  | { status: "unreliable"; reason: string }
  | { status: "ok"; position: AscendantPosition };

export interface NatalChart {
  input: BirthInput;
  /**
   * The UTC instant used to compute body positions: the exact birth instant
   * if `input.time` was given, otherwise local noon on the birthdate (see
   * `timeKnown`).
   */
  instant: Date;
  /** False when `instant` is a local-noon placeholder rather than an exact birth time. */
  timeKnown: boolean;
  bodies: Record<TransitBodyName, NatalBodyPosition>;
  ascendant: AscendantResult;
}

const MINUTES_PER_DAY = 24 * 60;
const MILLIS_PER_MINUTE = 60_000;

/**
 * Converts a local calendar date + optional clock time, at a given UTC
 * offset, to an absolute UTC instant.
 *
 * Local civil time = UTC + offset, so UTC = local - offset.
 */
function localToUtcMillis(
  date: BirthDate,
  hour: number,
  minute: number,
  utcOffsetMinutes: number,
): number {
  const localMillis = Date.UTC(date.year, date.month - 1, date.day, hour, minute, 0);
  return localMillis - utcOffsetMinutes * MILLIS_PER_MINUTE;
}

/** Throws if `location`'s fields are outside the ranges documented on `BirthLocation`. */
function assertValidLocation(location: BirthLocation): void {
  if (!Number.isFinite(location.latitude) || location.latitude < -90 || location.latitude > 90) {
    throw new Error(`BirthLocation.latitude out of range [-90, 90]: ${location.latitude}`);
  }
  if (!Number.isFinite(location.longitude) || location.longitude < -180 || location.longitude > 180) {
    throw new Error(`BirthLocation.longitude out of range [-180, 180]: ${location.longitude}`);
  }
}

/**
 * Computes the sign-change ambiguity flag for one body: compares its sign at
 * the very start of the birthdate (local midnight) against its sign at the
 * very start of the next day (local midnight + 24h), covering every possible
 * birth instant within the unknown-time day.
 *
 * The oracle-55h issue text suggested comparing "local-noon-start-of-day vs
 * local-noon-next-day" (a 24h-apart pair of instants) as one valid
 * day-boundary comparison; this uses the day's actual midnight-to-midnight
 * boundaries instead, which is a superset of that window and more faithful
 * to the spec's "changes sign during that day" wording (a birth could occur
 * at any clock time within the day, not just within the noon-to-noon span).
 */
function isAmbiguousForBody(
  bodyName: TransitBodyName,
  date: BirthDate,
  utcOffsetMinutes: number,
): boolean {
  const startOfDayMillis = localToUtcMillis(date, 0, 0, utcOffsetMinutes);
  const endOfDayMillis = startOfDayMillis + MINUTES_PER_DAY * MILLIS_PER_MINUTE;
  const startSign = positionForBody(bodyName, new Date(startOfDayMillis)).sign;
  const endSign = positionForBody(bodyName, new Date(endOfDayMillis)).sign;
  return startSign !== endSign;
}

/**
 * Below this, the east/west margin (see step 4 below) is too small to
 * reliably tell the Ascendant from the Descendant: the two candidate points
 * are nearly equidistant from the horizon's north/south point, so a tiny
 * numerical or timing difference can flip which one gets picked by ~180deg.
 *
 * A margin of `m` corresponds to the crossing point sitting `asin(m)`
 * degrees away from due north/south on the horizon (see the derivation
 * below); 0.2 is ~11.5deg of azimuth.
 *
 * Chosen from a worst-case scan (minimum margin over a full year, sampled
 * across each day, for a range of latitudes in both hemispheres -- see
 * oracle-55h review notes for the throwaway script; not checked in, since
 * it's a one-off empirical probe rather than app logic):
 *   lat 60  : worst-case margin ~0.606        (ordinary, never flagged)
 *   lat 65  : worst-case margin ~0.338        (ordinary, never flagged)
 *   lat 66.56 (Arctic/Antarctic Circle): worst-case margin ~0.010 (flagged)
 *   lat 67-90: worst-case margin < 0.0002, essentially always achievable
 *              (comfortably flagged)
 * There is a sharp transition right at the Arctic/Antarctic Circle (where
 * the ecliptic pole first becomes circumpolar for the observer), not a
 * gradual slide from the equator -- so a single threshold anywhere in
 * (0.01, 0.3) cleanly separates "ordinary" from "circumpolar-affected"
 * latitudes at their worst annual moment. 0.2 leaves comfortable headroom
 * on both sides, and -- unlike the original 0.1 -- also catches the
 * specific reviewer-reported instant (89.5deg N, 2024-05-10T08:15Z, margin
 * ~0.113) that the original threshold missed; see the regression test for
 * that exact case.
 */
const EAST_WEST_MARGIN_THRESHOLD = 0.2;

/**
 * Absolute latitude (degrees) beyond which the Ascendant is treated as
 * unreliable unconditionally, regardless of the margin above.
 *
 * This guards a *different* failure mode than the margin check, one that
 * the margin check cannot see at all: near the poles, `Observer.longitude`
 * stops corresponding to any real physical direction (there is no
 * meaningful "compass heading" standing at the pole), yet
 * `Rotation_EQD_HOR` still uses it to build the "north"/"west" basis
 * vectors. Verified empirically: at latitude 90 with a *high*-margin
 * instant (margin ~0.9998, i.e. one the check above would call very
 * confident), the computed Ascendant still collapsed to exactly one of two
 * fixed values (0deg or 180deg) depending only on which half-plane the
 * (physically meaningless) `location.longitude` fell in -- not a real
 * function of the birth instant at all. That dependence on longitude
 * shrinks continuously as latitude drops from 90 (e.g. at the same instant,
 * the spread across longitudes was already only ~1deg by 89.5deg, and a
 * few degrees by 89deg) -- there is no sharp cutoff for *this* phenomenon
 * either, so 89.9deg is a pragmatic choice, not a derived one: below it,
 * the longitude-driven error at a high-margin instant is a few degrees at
 * most (an accepted residual imprecision, not a sign-changing flip), and
 * the margin check above already independently catches every latitude's
 * worst-case near-zero-margin moments down to the Arctic/Antarctic Circle
 * (see that constant's comment), so this guard only needs to cover the
 * band where the margin check's "confident" answers can still be
 * physically arbitrary.
 *
 * KNOWN RESIDUAL RISK, accepted for this MVP: because both guards are
 * continuous phenomena rather than clean step functions, it is possible in
 * principle for some latitude/instant combination between the Arctic
 * Circle and this cutoff to have a margin just above 0.2 while still
 * carrying more numerical risk than a "safe" mid-latitude reading. This is
 * a deliberate, documented trade-off rather than an oversight -- treat any
 * Ascendant near the Arctic/Antarctic Circle or poleward with the
 * understanding that it is a best-effort estimate, not a guarantee.
 */
const POLAR_LATITUDE_GUARD_DEGREES = 89.9;

/**
 * Computes the Ascendant: the ecliptic longitude currently crossing the
 * eastern horizon.
 *
 * astronomy-engine has no direct "Ascendant" function. This is built from
 * its rotation-matrix primitives (not a memorized/hand-rolled trig formula):
 *
 *  1. `Rotation_ECT_EQD` (true ecliptic-of-date -> equator-of-date) composed
 *     with `Rotation_EQD_HOR` (equator-of-date -> horizontal, for the birth
 *     `Observer`) gives a matrix M that maps ECT-frame vectors to HOR-frame
 *     vectors (HOR: x=north, y=west, z=zenith, per astronomy-engine's docs).
 *     ECT is the frame `Astronomy.Ecliptic().elon` also uses elsewhere in
 *     this codebase, so the resulting longitude is directly comparable to
 *     the tropical longitudes used for signs everywhere else.
 *  2. A point *on* the ecliptic (ecliptic latitude 0) at longitude `lon` is,
 *     in the ECT frame, the unit vector (cos(lon), sin(lon), 0). Rotating it
 *     by M is linear, so its HOR z-component (altitude sine) as a function
 *     of `lon` is `M[0][2]*cos(lon) + M[1][2]*sin(lon)`. (Per
 *     astronomy-engine's own `RotateVector` source, `rot` is indexed
 *     `[inputAxis][outputAxis]`, i.e. `out[j] = sum_i rot[i][j] * in[i]` --
 *     the transpose of the "premultiply a column vector" layout its doc
 *     comment might suggest -- confirmed against `RotateVector` and by the
 *     self-consistency tests below.)
 *  3. The Ascendant/Descendant are exactly the two longitudes where that
 *     altitude is 0, i.e. where the ecliptic (a great circle through the
 *     origin) crosses the horizon (another great circle through the
 *     origin). Two great circles through the origin meet at exactly two
 *     antipodal points, 180deg apart, found by solving
 *     `A*cos(lon) + B*sin(lon) = 0` (a standard "R*cos(lon - phi) = 0" form)
 *     for `phi = atan2(B, A)`, giving roots `phi + 90deg` and `phi - 90deg`.
 *  4. Of those two roots, the Ascendant is the one on the eastern side of
 *     the sky (about to rise). HOR's y-axis points west, so east is
 *     negative y; we evaluate `M[0][1]*cos(lon) + M[1][1]*sin(lon)` (the
 *     HOR y-component) at each root and keep the one where it is negative.
 *     The magnitude of that y-component at the chosen root is the "margin"
 *     used by `EAST_WEST_MARGIN_THRESHOLD`: it is 0 exactly on the
 *     north/south line (a real ambiguity) and 1 exactly on the east/west
 *     line (maximally unambiguous).
 *
 * KNOWN LIMITATION (flagged for extra review scrutiny -- this is new,
 * unverified-by-reference-ephemeris math): step 4's east/west choice has
 * two distinct failure modes near the poles, covered by two distinct
 * guards (see their doc comments above for the full derivation and a
 * worst-case empirical scan):
 *  - At/beyond the Arctic/Antarctic Circle (~66.56deg latitude), the
 *    ecliptic pole can pass close to the zenith at specific sidereal
 *    times, making the margin genuinely approach 0 (`EAST_WEST_MARGIN_THRESHOLD`).
 *  - Near the true geographic poles (~89.9deg+), `location.longitude` stops
 *    corresponding to a real compass direction, so the computed Ascendant
 *    can be an arbitrary function of that meaningless input even when the
 *    margin looks confident (`POLAR_LATITUDE_GUARD_DEGREES`).
 * Both phenomena are continuous, not step functions, so neither guard's
 * threshold is a precisely "correct" boundary -- they are conservative,
 * empirically-informed cutoffs, and a residual risk remains for
 * latitude/instant combinations right at their edges. This is accepted for
 * an MVP astrology toy rather than chased further; see each constant's
 * comment for the specifics. Their test coverage lives in natal.test.ts,
 * using cross-checks and the specific instants found during review, not
 * assertions about any specific real-world Ascendant value.
 */
function computeAscendant(instant: Date, location: BirthLocation): AscendantResult {
  if (Math.abs(location.latitude) >= POLAR_LATITUDE_GUARD_DEGREES) {
    return {
      status: "unreliable",
      reason:
        "Birth location is at or very near the geographic pole, where no point in the sky rises or sets -- the Ascendant is not physically meaningful there.",
    };
  }

  const observer = new Astronomy.Observer(location.latitude, location.longitude, 0);
  const ectToEqd = Astronomy.Rotation_ECT_EQD(instant);
  const eqdToHor = Astronomy.Rotation_EQD_HOR(instant, observer);
  const ectToHor = Astronomy.CombineRotation(ectToEqd, eqdToHor);
  const m = ectToHor.rot;

  // `RotationMatrix.rot` is documented/constructed as a fixed 3x3 array;
  // this helper just gives TypeScript's noUncheckedIndexedAccess a checked
  // read instead of a bare non-null assertion at each call site.
  const at = (row: number, col: number): number => {
    const value = m[row]?.[col];
    if (value === undefined) {
      throw new Error(`Rotation_ECT_HOR matrix missing element [${row}][${col}]`);
    }
    return value;
  };

  const zHorCoeffA = at(0, 2);
  const zHorCoeffB = at(1, 2);
  const yHorCoeffA = at(0, 1);
  const yHorCoeffB = at(1, 1);

  const phiRad = Math.atan2(zHorCoeffB, zHorCoeffA);
  const rootRad1 = phiRad + Math.PI / 2;
  const rootRad2 = phiRad - Math.PI / 2;

  const yHorAt = (lonRad: number): number =>
    yHorCoeffA * Math.cos(lonRad) + yHorCoeffB * Math.sin(lonRad);

  const yHorAtRoot1 = yHorAt(rootRad1);
  const margin = Math.abs(yHorAtRoot1);
  if (margin < EAST_WEST_MARGIN_THRESHOLD) {
    return {
      status: "unreliable",
      reason:
        "The ecliptic crosses the horizon too close to due north/south here to reliably tell the Ascendant from the Descendant (common near the Arctic/Antarctic Circle and poleward).",
    };
  }

  const ascendantLonRad = yHorAtRoot1 < 0 ? rootRad1 : rootRad2;
  const ascendantLongitude = normalizeDegrees((ascendantLonRad * 180) / Math.PI);
  const { sign, degreeInSign } = signForLongitude(ascendantLongitude);
  return { status: "ok", position: { longitude: ascendantLongitude, sign, degreeInSign } };
}

/** Computes the natal chart for the given birth data. */
export function computeNatalChart(input: BirthInput): NatalChart {
  if (input.location) {
    assertValidLocation(input.location);
  }

  const utcOffsetMinutes = input.utcOffsetMinutes ?? 0;
  const birthTime = input.time;
  const timeKnown = birthTime !== undefined;

  const instantMillis = birthTime
    ? localToUtcMillis(input.date, birthTime.hour, birthTime.minute, utcOffsetMinutes)
    : localToUtcMillis(input.date, 12, 0, utcOffsetMinutes);
  const instant = new Date(instantMillis);

  const bodies = Object.fromEntries(
    TRANSIT_BODIES.map((bodyName) => {
      const position = positionForBody(bodyName, instant);
      const ambiguous = timeKnown
        ? false
        : isAmbiguousForBody(bodyName, input.date, utcOffsetMinutes);
      const natalPosition: NatalBodyPosition = { ...position, ambiguous };
      return [bodyName, natalPosition];
    }),
  ) as Record<TransitBodyName, NatalBodyPosition>;

  const ascendant: AscendantResult =
    timeKnown && input.location
      ? computeAscendant(instant, input.location)
      : { status: "not-computed" };

  return { input, instant, timeKnown, bodies, ascendant };
}
