/**
 * Renders the intake form (birthdate/city/time, question) into `container`
 * and resolves once it's been validly submitted. Extracted out of
 * sequencer.ts (oracle-sv9.6) into its own step module so later issues
 * (splash/gate/starfield/etc.) can compose it into the full sequence. A
 * `name` field briefly existed here (oracle-sv9.6) for possible future
 * personalization copy, but nothing ever consumed it and the project owner
 * confirmed it didn't add anything -- removed per that feedback.
 *
 * Layout follows the owner's landing-page sketch (oracle-rq3): birth date,
 * optional birth city, then "What is your question?" with the Ask button
 * inline. The city is looked up in the bundled GeoNames list (../../cities.ts)
 * for coordinates and a date-correct UTC offset; birth time and the raw
 * latitude/longitude/offset fields stay available (time as an optional field,
 * the raw values collapsed under "Advanced"), and anything typed in Advanced
 * overrides what the city would have supplied.
 *
 * Birth details are pre-filled from `loadBirthInput`/`loadBirthCity`
 * (localStorage, this device only) and re-saved on every successful submit --
 * "persist the birthdate, but allow it to change": every field stays a normal
 * editable input, this only changes what they start out containing.
 */
import { citiesFromRows, resolveCity, searchCities, utcOffsetMinutesAt, type City, type CityRow } from "../../cities";
import {
  formatBirthDateInput,
  formatBirthTimeInput,
  parseBirthDate,
  parseBirthTime,
  parseLocation,
  parseUtcOffsetMinutes,
} from "../../formInput";
import type { BirthInput } from "../../natal";
import { loadBirthCity, loadBirthInput, saveBirthCity, saveBirthInput } from "../birthInputStorage";
import { clearChildren, renderMessage, requireElementOfType } from "../dom";

function formatUtcOffsetInput(minutes: number): string {
  const hours = minutes / 60;
  // Trims a trailing ".00"/".50" back to the plain hours value a user would
  // have typed (e.g. -5, not -5.00) while still round-tripping quarter-hour
  // offsets like 5.25 or 5.75 exactly.
  return String(Math.round(hours * 100) / 100);
}

let citiesPromise: Promise<City[]> | undefined;

/** Lazily loads the ~130 KB (gzipped) city list as its own chunk, once, on first use. */
function loadCities(): Promise<City[]> {
  citiesPromise ??= import("../assets/cities.json").then((module) => citiesFromRows(module.default as unknown as CityRow[]));
  return citiesPromise;
}

export interface IntakeResult {
  birthInput: BirthInput;
  activityText: string;
}

export async function renderIntakeForm(container: HTMLElement): Promise<IntakeResult> {
  clearChildren(container);

  // Static markup only (no user data interpolated here); all dynamic content
  // below (error messages, city options) is set via textContent/properties/
  // renderMessage, never innerHTML, so activity text and other user input
  // can never be interpreted as markup.
  container.innerHTML = `
    <form id="oracle-form" class="intake-form" novalidate>
      <div class="field">
        <label for="birthdate">Birth date</label>
        <input type="date" id="birthdate" name="birthdate" required />
      </div>

      <div class="field">
        <label for="birthcity">Birth city <span class="optional">(optional)</span></label>
        <input type="text" id="birthcity" name="birthcity" list="birthcity-options" autocomplete="off" placeholder="Start typing a city" />
        <datalist id="birthcity-options"></datalist>
      </div>

      <div class="field">
        <label for="birthtime">Birth time <span class="optional">(optional)</span></label>
        <input type="time" id="birthtime" name="birthtime" />
      </div>

      <details id="birth-details">
        <summary>Advanced: exact coordinates &amp; UTC offset</summary>

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

        <p class="hint">Only needed if your city isn't listed. Values here override the city. Latitude and longitude go together.</p>
      </details>

      <div class="field">
        <label for="activity">What is your question?</label>
        <div class="ask-row">
          <input type="text" id="activity" name="activity" required placeholder="e.g. going bowling tonight" />
          <button type="submit">Ask JEV</button>
        </div>
      </div>
    </form>

    <div id="intake-message"></div>
  `;

  const form = requireElementOfType("oracle-form", HTMLFormElement);
  const birthdateInput = requireElementOfType("birthdate", HTMLInputElement);
  const birthcityInput = requireElementOfType("birthcity", HTMLInputElement);
  const birthcityOptions = requireElementOfType("birthcity-options", HTMLDataListElement);
  const birthtimeInput = requireElementOfType("birthtime", HTMLInputElement);
  const latitudeInput = requireElementOfType("latitude", HTMLInputElement);
  const longitudeInput = requireElementOfType("longitude", HTMLInputElement);
  const utcOffsetInput = requireElementOfType("utc-offset", HTMLInputElement);
  const activityInput = requireElementOfType("activity", HTMLInputElement);
  const messageContainer = requireElementOfType("intake-message", HTMLDivElement);
  const birthDetails = requireElementOfType("birth-details", HTMLDetailsElement);

  const remembered = loadBirthInput();
  const rememberedCity = loadBirthCity();
  if (remembered !== undefined) {
    birthdateInput.value = formatBirthDateInput(remembered.date);
    if (remembered.time !== undefined) {
      birthtimeInput.value = formatBirthTimeInput(remembered.time);
    }
    if (rememberedCity !== undefined) {
      // Coordinates/offset were derived from the city; recomputing them on
      // submit keeps them right if the birthdate is edited.
      birthcityInput.value = rememberedCity;
    } else {
      if (remembered.location !== undefined) {
        latitudeInput.value = String(remembered.location.latitude);
        longitudeInput.value = String(remembered.location.longitude);
        birthDetails.open = true;
      }
      if (remembered.utcOffsetMinutes !== undefined) {
        utcOffsetInput.value = formatUtcOffsetInput(remembered.utcOffsetMinutes);
        birthDetails.open = true;
      }
    }
  }

  birthcityInput.addEventListener("focus", () => void loadCities(), { once: true });
  birthcityInput.addEventListener("input", () => {
    const query = birthcityInput.value;
    void loadCities().then((cities) => {
      if (birthcityInput.value !== query) return; // a newer keystroke will refresh the list
      birthcityOptions.replaceChildren(
        ...searchCities(cities, query).map((city) => {
          const option = document.createElement("option");
          option.value = city.label;
          return option;
        }),
      );
    });
  });

  return new Promise<IntakeResult>((resolve) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void handleSubmit();
    });

    async function handleSubmit(): Promise<void> {
      clearChildren(messageContainer);

      // The form has `novalidate` so this check (rather than the browser's
      // own constraint-validation popups) drives the required-field
      // messaging, consistent with the app's other error styling; `required`
      // stays on the inputs themselves for semantics/assistive tech.
      const activityText = activityInput.value.trim();
      if (birthdateInput.value === "" || activityText === "") {
        renderMessage(messageContainer, "Enter a birth date and a question to ask JEV.", "error");
        return;
      }

      const { location: manualLocation, error: locationError } = parseLocation(latitudeInput.value, longitudeInput.value);
      if (locationError !== undefined) {
        birthDetails.open = true;
        renderMessage(messageContainer, locationError, "error");
        return;
      }

      const date = parseBirthDate(birthdateInput.value);
      const time = parseBirthTime(birthtimeInput.value);
      const manualOffset = parseUtcOffsetMinutes(utcOffsetInput.value);

      const cityText = birthcityInput.value.trim();
      let city: City | undefined;
      if (cityText !== "" && manualLocation === undefined) {
        let cities: City[];
        try {
          cities = await loadCities();
        } catch (error) {
          console.error("Cosmic JEV: failed to load the city list", error);
          citiesPromise = undefined; // let the next attempt retry the fetch
          renderMessage(messageContainer, "The city list couldn't load. Try again, or enter coordinates under Advanced.", "error");
          return;
        }
        city = resolveCity(cities, cityText);
        if (city === undefined) {
          renderMessage(
            messageContainer,
            `Couldn't find "${cityText}". Pick a city from the suggestions, or enter coordinates under Advanced.`,
            "error",
          );
          return;
        }
        birthcityInput.value = city.label;
      }

      const birthInput: BirthInput = {
        date,
        time,
        location: manualLocation ?? (city && { latitude: city.latitude, longitude: city.longitude }),
        utcOffsetMinutes: manualOffset ?? (city && utcOffsetMinutesAt(city.timeZone, date, time)),
      };

      saveBirthInput(birthInput);
      saveBirthCity(city?.label ?? "");
      resolve({ birthInput, activityText });
    }
  });
}
