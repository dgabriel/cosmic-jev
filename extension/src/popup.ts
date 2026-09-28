/**
 * One-time (well, editable-anytime) birth-details entry, reusing the main
 * app's own form-parsing helpers (src/formInput.ts) so the exact same rules
 * (lat/long required together, UTC-offset-in-hours -> minutes, etc.) apply
 * here too. Saved via storage.ts's chrome.storage.local wrapper -- "it
 * should remember your birth details," per the project owner -- so this
 * popup only needs to be filled in once; it pre-fills from whatever's
 * already saved on every open.
 */
import { parseBirthDate, parseBirthTime, parseLocation, parseUtcOffsetMinutes } from "../../src/formInput";
import type { BirthInput } from "../../src/natal";
import { loadBirthInput, saveBirthInput } from "./storage";

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function formatBirthDate(birthInput: BirthInput): string {
  const { year, month, day } = birthInput.date;
  return `${String(year).padStart(4, "0")}-${pad2(month)}-${pad2(day)}`;
}

function formatBirthTime(birthInput: BirthInput): string {
  if (birthInput.time === undefined) return "";
  return `${pad2(birthInput.time.hour)}:${pad2(birthInput.time.minute)}`;
}

const app = document.getElementById("app");
if (app === null) {
  throw new Error("Missing #app mount point in popup.html");
}

app.innerHTML = `
  <h1>Cosmic JEV</h1>
  <p class="tagline">Your birth details, remembered on this device only.</p>
  <form id="birth-form">
    <div class="field">
      <label for="birthdate">Birthdate</label>
      <input type="date" id="birthdate" required />
    </div>

    <details id="birth-details">
      <summary>Add exact birth time &amp; location (optional, sharpens the chart)</summary>

      <div class="field">
        <label for="birthtime">Birth time</label>
        <input type="time" id="birthtime" />
      </div>

      <div class="field-row">
        <div class="field">
          <label for="latitude">Latitude</label>
          <input type="number" id="latitude" step="any" min="-90" max="90" placeholder="e.g. 40.71" />
        </div>
        <div class="field">
          <label for="longitude">Longitude</label>
          <input type="number" id="longitude" step="any" min="-180" max="180" placeholder="e.g. -74.01" />
        </div>
      </div>

      <div class="field">
        <label for="utc-offset">UTC offset (hours)</label>
        <input type="number" id="utc-offset" step="0.25" placeholder="e.g. -5" />
      </div>
    </details>

    <button type="submit">Save</button>
    <p id="status"></p>
  </form>
`;

function requireInput(id: string): HTMLInputElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLInputElement)) {
    throw new Error(`Missing or mistyped #${id} input`);
  }
  return element;
}

const form = document.getElementById("birth-form");
if (!(form instanceof HTMLFormElement)) {
  throw new Error("Missing #birth-form");
}
const birthdateInput = requireInput("birthdate");
const birthtimeInput = requireInput("birthtime");
const latitudeInput = requireInput("latitude");
const longitudeInput = requireInput("longitude");
const utcOffsetInput = requireInput("utc-offset");
const status = document.getElementById("status");
if (status === null) {
  throw new Error("Missing #status");
}

void loadBirthInput().then((existing) => {
  if (existing === undefined) return;
  birthdateInput.value = formatBirthDate(existing);
  birthtimeInput.value = formatBirthTime(existing);
  if (existing.location !== undefined) {
    latitudeInput.value = String(existing.location.latitude);
    longitudeInput.value = String(existing.location.longitude);
  }
  if (existing.utcOffsetMinutes !== undefined) {
    utcOffsetInput.value = String(existing.utcOffsetMinutes / 60);
  }
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  status.textContent = "";

  if (birthdateInput.value === "") {
    status.textContent = "Enter a birthdate.";
    return;
  }

  const { location, error: locationError } = parseLocation(latitudeInput.value, longitudeInput.value);
  if (locationError !== undefined) {
    status.textContent = locationError;
    return;
  }

  const birthInput: BirthInput = {
    date: parseBirthDate(birthdateInput.value),
    time: parseBirthTime(birthtimeInput.value),
    location,
    utcOffsetMinutes: parseUtcOffsetMinutes(utcOffsetInput.value),
  };

  void saveBirthInput(birthInput).then(() => {
    status.textContent = "Saved. Visit eventbrite.com to see it in action.";
  });
});
