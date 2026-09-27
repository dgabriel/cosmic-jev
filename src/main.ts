/**
 * UI (oracle-zqz): builds the form, wires the birthdate/time/location/
 * activity inputs to `computeNatalChart`/`computeTransitChart`, runs
 * `askOracle`, and renders one of the four outcomes (verdict, recusal,
 * needs-detail, error) plus any ambiguity notices. All DOM manipulation
 * lives here; the pure explanation templating lives in ./explain.ts so it
 * can be unit-tested without a DOM.
 *
 * `new Date()` is called exactly once, right before `computeTransitChart`:
 * per docs/spec.md, sky.ts/natal.ts/aspects.ts/oracle.ts all take dates as
 * parameters and never read the clock themselves, so this is the one
 * legitimate place in the app that does.
 */
import { ORACLE_KIND } from "./config";
import { emojiFor, explainAmbiguity, explainDisclaimer, explainOutcome, firmnessFor } from "./explain";
import { parseBirthDate, parseBirthTime, parseLocation, parseUtcOffsetMinutes } from "./formInput";
import { computeNatalChart, type BirthInput, type NatalChart } from "./natal";
import { askOracle, createOracle, type OracleOutcome } from "./oracle";
import { computeTransitChart } from "./sky";

const app = document.getElementById("app");
if (app === null) {
  throw new Error("Missing #app mount point in index.html");
}

// Static markup only (no user data interpolated here); all dynamic content
// below is set via textContent, never innerHTML, so activity text and other
// user input can never be interpreted as markup.
app.innerHTML = `
  <div class="app">
    <header>
      <h1>Cosmic JEV</h1>
      <p class="tagline">Real planetary positions. Absurd question. Deadpan answer.</p>
    </header>

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

    <div id="ambiguity-notes"></div>
    <section id="result" aria-live="polite"></section>
  </div>
`;

app.dataset["oracle"] = ORACLE_KIND;

/**
 * Looks up `#id` and throws unless it is actually an instance of `ctor` --
 * a real runtime check (rather than an unchecked type-assertion cast, which
 * project rules forbid) so a wrong id/element-type pairing in the markup
 * above throws a clear error immediately instead of silently producing a
 * mistyped reference that fails confusingly later (e.g. `.value` on a `<div>`).
 */
function requireElementOfType<T extends HTMLElement>(id: string, ctor: new () => T): T {
  const element = document.getElementById(id);
  if (!(element instanceof ctor)) {
    throw new Error(`Missing or mistyped #${id} element (expected ${ctor.name})`);
  }
  return element;
}

const form = requireElementOfType("oracle-form", HTMLFormElement);
const birthdateInput = requireElementOfType("birthdate", HTMLInputElement);
const birthtimeInput = requireElementOfType("birthtime", HTMLInputElement);
const latitudeInput = requireElementOfType("latitude", HTMLInputElement);
const longitudeInput = requireElementOfType("longitude", HTMLInputElement);
const utcOffsetInput = requireElementOfType("utc-offset", HTMLInputElement);
const activityInput = requireElementOfType("activity", HTMLInputElement);
const ambiguitySection = requireElementOfType("ambiguity-notes", HTMLDivElement);
const resultSection = requireElementOfType("result", HTMLElement);

function clearChildren(element: Element): void {
  element.replaceChildren();
}

function renderMessage(container: Element, text: string, kind: "error" | "pending" | "info"): void {
  clearChildren(container);
  const paragraph = document.createElement("p");
  paragraph.className = `message message-${kind}`;
  paragraph.textContent = text;
  container.append(paragraph);
}

function renderAmbiguity(natal: NatalChart): void {
  const messages = explainAmbiguity(natal);
  clearChildren(ambiguitySection);
  if (messages.length === 0) return;
  const list = document.createElement("ul");
  for (const message of messages) {
    const item = document.createElement("li");
    item.textContent = message;
    list.append(item);
  }
  ambiguitySection.append(list);
}

/**
 * Renders the "verdict" outcome: a big 👍/👎 (per spec section 3), the
 * Firmly/Tentatively label, and the full templated explanation from
 * ./explain.ts below it. The emoji and firmness also appear at the end of
 * the explanation sentence itself (per the spec's own example wording) --
 * that repetition is intentional, not a bug: the big emoji is the at-a-
 * glance result, the sentence is the deadpan reasoning.
 */
function renderVerdict(outcome: Extract<OracleOutcome, { kind: "verdict" }>, activityText: string): void {
  clearChildren(resultSection);

  const card = document.createElement("div");
  card.className = "verdict";

  const emoji = emojiFor(outcome.favor);
  const firmness = firmnessFor(outcome.favor);

  const big = document.createElement("div");
  big.className = "verdict-emoji";
  big.setAttribute("role", "img");
  big.setAttribute("aria-label", `${firmness} ${emoji === "👍" ? "thumbs up" : "thumbs down"}`);
  big.textContent = emoji;

  const firmnessLabel = document.createElement("p");
  firmnessLabel.className = "verdict-firmness";
  firmnessLabel.textContent = firmness;

  const explanation = document.createElement("p");
  explanation.className = "verdict-explanation";
  explanation.textContent = explainOutcome(outcome, activityText);

  card.append(big, firmnessLabel, explanation);

  // Visible, separate element (not folded into `explanation`) for
  // disclaimer-flagged verdicts (health/money/relationship_ending/
  // job_quitting -- oracle-2au): `explainDisclaimer` returns `undefined` for
  // every other outcome, so this only appends anything when it applies.
  const disclaimerText = explainDisclaimer(outcome);
  if (disclaimerText !== undefined) {
    const disclaimer = document.createElement("p");
    disclaimer.className = "verdict-disclaimer";
    disclaimer.textContent = disclaimerText;
    card.append(disclaimer);
  }

  resultSection.append(card);
}

function renderOutcome(outcome: OracleOutcome, activityText: string): void {
  if (outcome.kind === "verdict") {
    renderVerdict(outcome, activityText);
    return;
  }
  renderMessage(resultSection, explainOutcome(outcome, activityText), "info");
}

async function handleSubmit(): Promise<void> {
  clearChildren(ambiguitySection);

  // The form has `novalidate` so this check (rather than the browser's own
  // constraint-validation popups) drives the required-field messaging,
  // consistent with the app's other error styling; `required` stays on the
  // inputs themselves for semantics/assistive tech.
  const activityText = activityInput.value.trim();
  if (birthdateInput.value === "" || activityText === "") {
    renderMessage(resultSection, "Enter a birthdate and an activity to consult the oracle.", "error");
    return;
  }

  const { location, error: locationError } = parseLocation(latitudeInput.value, longitudeInput.value);
  if (locationError !== undefined) {
    renderMessage(resultSection, locationError, "error");
    return;
  }

  const birthInput: BirthInput = {
    date: parseBirthDate(birthdateInput.value),
    time: parseBirthTime(birthtimeInput.value),
    location,
    utcOffsetMinutes: parseUtcOffsetMinutes(utcOffsetInput.value),
  };

  renderMessage(resultSection, "Consulting the stars…", "pending");

  try {
    const natal = computeNatalChart(birthInput);
    const transits = computeTransitChart(new Date());
    const oracle = createOracle(ORACLE_KIND);
    const outcome = await askOracle(oracle, { transits, natal, activityText });

    renderAmbiguity(natal);
    renderOutcome(outcome, activityText);
  } catch (error) {
    console.error("Cosmic JEV: failed to produce an outcome", error);
    renderMessage(
      resultSection,
      "The oracle couldn't be reached just now. Please try again in a moment.",
      "error",
    );
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void handleSubmit();
});
