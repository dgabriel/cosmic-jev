/**
 * "Swirls and swirls, in 5s resolves into the star sign entered" beat
 * (bar-napkin "Cosmic spec"): mounts a star field, fades it in, and swirls a
 * subset of its own stars into the real constellation shape for the natal
 * Sun's zodiac sign (../constellations.ts) plus any ambiguity captions. The
 * resolved image is the star field's own particles redrawn into a
 * recognizable shape, not a separate diagram layered on top of it -- per an
 * explicit correction from the project owner, who did not want the earlier
 * SVG zodiac wheel (zodiacWheel.ts, still in the repo but unused by this
 * beat) shown here.
 *
 * This briefly swirled through several random "decoy" constellations first,
 * each with its own fading name label, before landing on the real one -- the
 * project owner tried it and asked to cut it: "just spin up the correct
 * constellation and the response, no pics."
 *
 * Synchronous, not awaited by the sequencer: mounts the starfield and kicks
 * off its fade-in/swirl/label as a background sequence, returning the handle
 * immediately so the caller can show the actual result at the same time
 * ("instant results while the constellation resolves" -- the haruspicy
 * placeholder-card beat that used to sit between this and the reveal is
 * gone entirely, per that same request).
 */
import { explainAmbiguity } from "../../explain";
import type { NatalChart } from "../../natal";
import { mountStarfield, type StarfieldHandle } from "./starfield";

/** Matches the plan's `FADE_IN_MS` note for the black-screen star-field fade-in. */
const FADE_IN_MS = 1500;

function showSignLabel(container: HTMLElement, natal: NatalChart): void {
  const sunSign = natal.bodies.Sun.sign;
  const label = document.createElement("div");
  label.className = "sign-resolve-label";
  // Absolutely positioned (like the starfield's own canvas), anchored near
  // the bottom of the overlay, rather than left to the overlay's own
  // flex-centering -- the constellation itself is drawn centered on the
  // canvas, so a normal-flow, flex-centered label would land right on top of
  // it instead of clear of it.
  label.style.position = "absolute";
  label.style.left = "0";
  label.style.right = "0";
  label.style.bottom = "10%";
  label.style.textAlign = "center";
  // Purely informational (no interactive content), but being absolutely
  // positioned would otherwise let it paint/hit-test above later,
  // normal-flow UI per CSS stacking rules -- see starfield.ts's matching fix
  // on its canvas for the bug this exact thing caused there.
  label.style.pointerEvents = "none";

  const heading = document.createElement("p");
  heading.className = "sign-resolve-sign-name";
  heading.style.margin = "0";
  heading.style.fontSize = "1.5rem";
  heading.style.fontWeight = "600";
  heading.style.letterSpacing = "0.04em";
  heading.textContent = sunSign;
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

export function runSignResolveBeat(
  container: HTMLElement,
  natal: NatalChart,
  opts?: { durationMs?: number },
): StarfieldHandle {
  const handle = mountStarfield(container);
  const sunSign = natal.bodies.Sun.sign;

  // Fire-and-forget: the caller gets `handle` back immediately (see the
  // module doc comment for why) while this keeps running in the background.
  void (async () => {
    await handle.fadeIn(FADE_IN_MS);
    await handle.swirlIntoShape(sunSign, opts?.durationMs ?? 5000);
    showSignLabel(container, natal);
  })();

  // Not destroyed here, and never will be by this module: the resolved
  // constellation stays lit and visible (with the final reveal's own result
  // overlaid on top of it, not replacing it) for as long as the caller wants
  // it. The caller owns this handle and must call `destroy()` once it's
  // actually done with the starfield -- otherwise its persistent d3.timer
  // leaks.
  return handle;
}
