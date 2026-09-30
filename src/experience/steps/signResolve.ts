/**
 * "Swirls and swirls, in 5s resolves into the star sign entered" beat
 * (bar-napkin "Cosmic spec"): swirls a subset of the landing page's own
 * starfield into the real constellation shape for the natal Sun's zodiac sign
 * (../constellations.ts), and names the sign (plus any ambiguity captions)
 * alongside the result. The resolved image is the star field's own particles
 * redrawn into a recognizable shape, not a separate diagram layered on top of
 * it -- per an explicit correction from the project owner, who did not want
 * the earlier SVG zodiac wheel (zodiacWheel.ts, still in the repo but unused
 * by this beat) shown here.
 *
 * This used to mount its own starfield in a separate full-screen overlay; per
 * the project owner ("stay on the same page, replace the form with the
 * result"), it now reuses the intake page's sky, which is already faded in.
 * The swirl runs in the background while the result shows immediately
 * ("instant results while the constellation resolves").
 */
import { explainAmbiguity } from "../../explain";
import type { NatalChart } from "../../natal";
import type { StarfieldHandle } from "./starfield";

const SWIRL_MS = 5000;

/** Appends the Sun-sign name and any ambiguity captions to `container`, in normal flow. */
function renderSignLabel(container: HTMLElement, natal: NatalChart): void {
  const label = document.createElement("div");
  label.className = "sign-resolve-label";

  const heading = document.createElement("p");
  heading.className = "sign-resolve-sign-name";
  heading.textContent = natal.bodies.Sun.sign;
  label.append(heading);

  const messages = explainAmbiguity(natal);
  if (messages.length > 0) {
    const captions = document.createElement("div");
    captions.id = "ambiguity-notes";
    const list = document.createElement("ul");
    for (const message of messages) {
      const item = document.createElement("li");
      item.textContent = message;
      list.append(item);
    }
    captions.append(list);
    label.append(captions);
  }

  container.append(label);
}

export function runSignResolveBeat(sky: StarfieldHandle, labelHost: HTMLElement, natal: NatalChart): void {
  void sky.swirlIntoShape(natal.bodies.Sun.sign, SWIRL_MS);
  renderSignLabel(labelHost, natal);
}
