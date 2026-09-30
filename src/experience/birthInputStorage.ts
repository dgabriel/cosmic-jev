/**
 * Persisted birth details for the web app (per the project owner: "please
 * persist the birthdate, but allow it to change"). `localStorage`, on this
 * device/browser only -- matches the project's "nothing about the user is
 * stored server-side" rule; this isn't server-side storage at all. Mirrors
 * the Eventbrite extension's own chrome.storage.local wrapper
 * (extension/src/storage.ts) one layer down, since a web page has no
 * chrome.storage API to reuse.
 */
import type { BirthInput } from "../natal";

const STORAGE_KEY = "cosmicJevBirthInput";

/**
 * `localStorage` can throw (private/incognito browsing in some browsers,
 * storage disabled by the user, quota exceeded) -- remembering the last
 * birthdate is a convenience, not something the form depends on to work, so
 * every operation here fails silently rather than breaking the form.
 */
export function loadBirthInput(): BirthInput | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return undefined;
    return JSON.parse(raw) as BirthInput;
  } catch {
    return undefined;
  }
}

export function saveBirthInput(birthInput: BirthInput): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(birthInput));
  } catch {
    // See the module comment: persistence failing here is not fatal.
  }
}

const CITY_STORAGE_KEY = "cosmicJevBirthCity";

/**
 * The birth-city field's text, kept separately from `BirthInput` (which only
 * holds the resolved coordinates/offset) so a returning visitor sees the city
 * they picked rather than raw numbers in the advanced fields. Same
 * fail-silently rules as above.
 */
export function loadBirthCity(): string | undefined {
  try {
    return localStorage.getItem(CITY_STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function saveBirthCity(city: string): void {
  try {
    if (city === "") localStorage.removeItem(CITY_STORAGE_KEY);
    else localStorage.setItem(CITY_STORAGE_KEY, city);
  } catch {
    // See the module comment: persistence failing here is not fatal.
  }
}
