/**
 * Birth-city lookup for the intake form's "Birth city" field: searching the
 * bundled GeoNames city list (src/experience/assets/cities.json, regenerated
 * by scripts/build-cities.mjs) and turning a city's IANA time zone into the
 * UTC offset that was actually in effect on the birthdate -- including DST
 * and historical rule changes, via the browser's own tz database (`Intl`).
 * Pure and DOM-free like formInput.ts, so it's unit-testable directly; the
 * JSON itself is loaded lazily by the form, not imported here.
 */
import type { BirthDate, BirthTime } from "./natal";

/** One row of cities.json: [name, admin1 name, country code, latitude, longitude, IANA time zone]. */
export type CityRow = readonly [string, string, string, number, number, string];

export interface City {
  name: string;
  admin1: string;
  countryCode: string;
  latitude: number;
  longitude: number;
  timeZone: string;
  /** Display string, also the autocomplete option value, e.g. "Portland, Oregon, United States". */
  label: string;
}

let countryNames: Intl.DisplayNames | undefined;

function countryName(code: string): string {
  countryNames ??= new Intl.DisplayNames(["en"], { type: "region" });
  return countryNames.of(code) ?? code;
}

/** Rows arrive population-descending; that order is preserved and is the search tie-break. */
export function citiesFromRows(rows: readonly CityRow[]): City[] {
  return rows.map(([name, admin1, countryCode, latitude, longitude, timeZone]) => {
    // Skips an admin1 that just repeats the city name ("Tokyo, Tokyo, Japan").
    const parts = admin1 !== "" && admin1 !== name ? [name, admin1, countryName(countryCode)] : [name, countryName(countryCode)];
    return { name, admin1, countryCode, latitude, longitude, timeZone, label: parts.join(", ") };
  });
}

/** Lowercase, accent-folded, whitespace-collapsed -- so "sao paulo" finds "São Paulo". */
function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Up to `limit` cities for an autocomplete query: city names starting with
 * the query first, then labels containing it anywhere (e.g. "oregon"), each
 * group in population order.
 */
export function searchCities(cities: readonly City[], query: string, limit = 8): City[] {
  const q = normalize(query);
  if (q === "") return [];
  const prefix: City[] = [];
  const contains: City[] = [];
  for (const city of cities) {
    if (normalize(city.name).startsWith(q)) {
      prefix.push(city);
      if (prefix.length >= limit) break;
    } else if (contains.length < limit && normalize(city.label).includes(q)) {
      contains.push(city);
    }
  }
  return [...prefix, ...contains].slice(0, limit);
}

/**
 * Resolves what's in the city field on submit: an exact label (what picking
 * an autocomplete option produces), else the most populous city whose name
 * matches the text before the first comma and whose region/country match
 * each part after it ("Paris" -> Paris, France; "Portland, Oregon" and
 * "Paris, Texas" -> the US ones; "Paris, FR" by country code), else
 * undefined.
 */
export function resolveCity(cities: readonly City[], text: string): City | undefined {
  const q = normalize(text);
  if (q === "") return undefined;
  const exact = cities.find((city) => normalize(city.label) === q);
  if (exact !== undefined) return exact;

  const [name = "", ...qualifiers] = q.split(",").map((part) => part.trim()).filter((part) => part !== "");
  return cities.find((city) => {
    if (normalize(city.name) !== name) return false;
    const places = [normalize(city.admin1), normalize(countryName(city.countryCode)), city.countryCode.toLowerCase()];
    return qualifiers.every((qualifier) => places.some((place) => place.startsWith(qualifier)));
  });
}

/** Offset (minutes east of UTC) that `timeZone` observed at the instant `epochMillis`. */
function offsetAtInstant(timeZone: string, epochMillis: number): number {
  const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(new Date(epochMillis))
    .find((p) => p.type === "timeZoneName");
  // "GMT" alone for UTC itself, otherwise "GMT+05:30" / "GMT-08:00".
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(part?.value ?? "");
  if (match === null) return 0;
  const [, sign, hours, minutes] = match;
  return (sign === "-" ? -1 : 1) * (Number(hours) * 60 + Number(minutes));
}

/**
 * UTC offset in minutes that `timeZone` observed at local wall-clock `date`
 * `time` (local noon when no time is given, matching natal.ts's no-time
 * convention). Two passes because the offset depends on the instant, and the
 * instant depends on the offset; the second pass settles DST boundaries.
 */
export function utcOffsetMinutesAt(timeZone: string, date: BirthDate, time?: BirthTime): number {
  const wall = new Date(0);
  wall.setUTCFullYear(date.year, date.month - 1, date.day);
  wall.setUTCHours(time?.hour ?? 12, time?.minute ?? 0, 0, 0);
  const wallMillis = wall.getTime();
  const firstGuess = offsetAtInstant(timeZone, wallMillis);
  return offsetAtInstant(timeZone, wallMillis - firstGuess * 60_000);
}
