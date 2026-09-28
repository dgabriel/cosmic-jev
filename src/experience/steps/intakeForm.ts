/**
 * Renders the intake form (birthdate/time/location, activity) into
 * `container` and resolves once it's been validly submitted. Extracted out
 * of sequencer.ts (oracle-sv9.6) into its own step module so later issues
 * (splash/gate/starfield/etc.) can compose it into the full sequence. A
 * `name` field briefly existed here (oracle-sv9.6) for possible future
 * personalization copy, but nothing ever consumed it and the project owner
 * confirmed it didn't add anything -- removed per that feedback.
 *
 * Birth details are pre-filled from `loadBirthInput` (localStorage, this
 * device only) and re-saved on every successful submit -- "persist the
 * birthdate, but allow it to change": every field stays a normal editable
 * input, this only changes what they start out containing.
 */
import {
  formatBirthDateInput,
  formatBirthTimeInput,
  parseBirthDate,
  parseBirthTime,
  parseLocation,
  parseUtcOffsetMinutes,
} from "../../formInput";
import type { BirthInput } from "../../natal";
import { loadBirthInput, saveBirthInput } from "../birthInputStorage";
import { clearChildren, renderMessage, requireElementOfType } from "../dom";

function formatUtcOffsetInput(minutes: number): string {
  const hours = minutes / 60;
  // Trims a trailing ".00"/".50" back to the plain hours value a user would
  // have typed (e.g. -5, not -5.00) while still round-tripping quarter-hour
  // offsets like 5.25 or 5.75 exactly.
  return String(Math.round(hours * 100) / 100);
}

export interface IntakeResult {
  birthInput: BirthInput;
  activityText: string;
}

export async function renderIntakeForm(container: HTMLElement): Promise<IntakeResult> {
  clearChildren(container);

  // Static markup only (no user data interpolated here); all dynamic content
  // below (error messages) is set via textContent/renderMessage, never
  // innerHTML, so activity text and other user input can never be
  // interpreted as markup.
  container.innerHTML = `
    <form id="oracle-form" novalidate>
      <div class="field">
        <label for="birthdate">Birthdate</label>
        <input type="date" id="birthdate" name="birthdate" required />
      </div>

      <details id="birth-details">
        <summary>Add exact birth time &amp; location (optional, sharpens the chart)</summary>

        <div class="field">
          <label for="birthtime">Birth time</label>
          <input type="time" id="birthtime" name="birthtime" />
        </div>

        <div class="field-row">
          <div class="field">
            <label for="latitude">Latitude</label>
            <input type="number" id="latitude" name="latitude" step="any" min="-90" max="90" placeholder="e.g. 40.71" />
          </div>
          <div class="field">
            <label for="longitude">Longitude</label>
            <input type="number" id="longitude" name="longitude" step="any" min="-180" max="180" placeholder="e.g. -74.01" />
          </div>
        </div>

        <div class="field">
          <label for="utc-offset">UTC offset (hours)</label>
          <input type="number" id="utc-offset" name="utc-offset" step="0.25" placeholder="e.g. -5" />
        </div>

        <p class="hint">Latitude and longitude are needed together, or leave both blank.</p>
      </details>

      <div class="field">
        <label for="activity">What are you asking about?</label>
        <input type="text" id="activity" name="activity" required placeholder="e.g. going bowling tonight" />
      </div>

      <button type="submit">Consult the oracle</button>
    </form>

    <div id="intake-message"></div>
  `;

  const form = requireElementOfType("oracle-form", HTMLFormElement);
  const birthdateInput = requireElementOfType("birthdate", HTMLInputElement);
  const birthtimeInput = requireElementOfType("birthtime", HTMLInputElement);
  const latitudeInput = requireElementOfType("latitude", HTMLInputElement);
  const longitudeInput = requireElementOfType("longitude", HTMLInputElement);
  const utcOffsetInput = requireElementOfType("utc-offset", HTMLInputElement);
  const activityInput = requireElementOfType("activity", HTMLInputElement);
  const messageContainer = requireElementOfType("intake-message", HTMLDivElement);

  const remembered = loadBirthInput();
  if (remembered !== undefined) {
    birthdateInput.value = formatBirthDateInput(remembered.date);
    if (remembered.time !== undefined) {
      birthtimeInput.value = formatBirthTimeInput(remembered.time);
    }
    if (remembered.location !== undefined) {
      latitudeInput.value = String(remembered.location.latitude);
      longitudeInput.value = String(remembered.location.longitude);
    }
    if (remembered.utcOffsetMinutes !== undefined) {
      utcOffsetInput.value = formatUtcOffsetInput(remembered.utcOffsetMinutes);
    }
  }

  return new Promise<IntakeResult>((resolve) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      clearChildren(messageContainer);

      // The form has `novalidate` so this check (rather than the browser's
      // own constraint-validation popups) drives the required-field
      // messaging, consistent with the app's other error styling; `required`
      // stays on the inputs themselves for semantics/assistive tech.
      const activityText = activityInput.value.trim();
      if (birthdateInput.value === "" || activityText === "") {
        renderMessage(messageContainer, "Enter a birthdate and an activity to consult the oracle.", "error");
        return;
      }

      const { location, error: locationError } = parseLocation(latitudeInput.value, longitudeInput.value);
      if (locationError !== undefined) {
        renderMessage(messageContainer, locationError, "error");
        return;
      }

      const birthInput: BirthInput = {
        date: parseBirthDate(birthdateInput.value),
        time: parseBirthTime(birthtimeInput.value),
        location,
        utcOffsetMinutes: parseUtcOffsetMinutes(utcOffsetInput.value),
      };

      saveBirthInput(birthInput);
      resolve({ birthInput, activityText });
    });
  });
}
