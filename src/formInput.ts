/**
 * Pure form-input parsing/validation (oracle-zqz): native `<input>` string
 * values -> typed `BirthInput` fields, or a validation error message. No DOM
 * dependency (these take plain strings, not `Element` references) and no
 * side effects, so they're unit-testable directly -- unlike src/main.ts,
 * which mounts the real app and touches `document` at import time.
 */
import type { BirthDate, BirthLocation, BirthTime } from "./natal";

/** Parses a native `<input type="date">` value ("YYYY-MM-DD") into a `BirthDate`. */
export function parseBirthDate(value: string): BirthDate {
  const [yearStr = "", monthStr = "", dayStr = ""] = value.split("-");
  return { year: Number(yearStr), month: Number(monthStr), day: Number(dayStr) };
}

/** Parses a native `<input type="time">` value ("HH:MM"), or undefined if blank. */
export function parseBirthTime(value: string): BirthTime | undefined {
  if (value.trim() === "") return undefined;
  const [hourStr = "", minuteStr = ""] = value.split(":");
  return { hour: Number(hourStr), minute: Number(minuteStr) };
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** Inverse of `parseBirthDate`: a `BirthDate` back into an `<input type="date">` value ("YYYY-MM-DD"), for pre-filling a remembered value. */
export function formatBirthDateInput(date: BirthDate): string {
  return `${String(date.year).padStart(4, "0")}-${pad2(date.month)}-${pad2(date.day)}`;
}

/** Inverse of `parseBirthTime`: a `BirthTime` back into an `<input type="time">` value ("HH:MM"), for pre-filling a remembered value. */
export function formatBirthTimeInput(time: BirthTime): string {
  return `${pad2(time.hour)}:${pad2(time.minute)}`;
}

/**
 * Parses the latitude/longitude fields into a `BirthLocation`. Both must be
 * given together (or both left blank) since `BirthLocation` has no partial
 * form -- a lone latitude or longitude is treated as a user error and
 * reported rather than silently dropped. Range-validated here too (matching
 * natal.ts's `assertValidLocation` bounds exactly: latitude [-90, 90],
 * longitude [-180, 180]) so an out-of-range value gets a specific,
 * actionable message from this function's caller, rather than reaching
 * `computeNatalChart`, throwing there, and being caught by the generic
 * "oracle couldn't be reached" catch-all in main.ts's `handleSubmit` --
 * which would be misleading for what's actually an input mistake, not a
 * network/oracle failure.
 */
export function parseLocation(
  latitudeValue: string,
  longitudeValue: string,
): { location?: BirthLocation; error?: string } {
  const latitudeText = latitudeValue.trim();
  const longitudeText = longitudeValue.trim();
  if (latitudeText === "" && longitudeText === "") {
    return {};
  }
  if (latitudeText === "" || longitudeText === "") {
    return { error: "Enter both latitude and longitude, or leave both blank." };
  }
  const latitude = Number(latitudeText);
  const longitude = Number(longitudeText);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { error: "Latitude and longitude must be numbers." };
  }
  if (latitude < -90 || latitude > 90) {
    return { error: "Latitude must be between -90 and 90." };
  }
  if (longitude < -180 || longitude > 180) {
    return { error: "Longitude must be between -180 and 180." };
  }
  return { location: { latitude, longitude } };
}

/** Parses the UTC-offset-in-hours field into minutes, or undefined if blank/unparseable. */
export function parseUtcOffsetMinutes(value: string): number | undefined {
  const text = value.trim();
  if (text === "") return undefined;
  const hours = Number(text);
  if (!Number.isFinite(hours)) return undefined;
  return Math.round(hours * 60);
}
