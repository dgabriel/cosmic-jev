/**
 * Verdict-resolve beat: thumb emoji + headline + justification sentence +
 * disclaimer (when flagged) + an "Again" affordance. Mounted by the
 * sequencer right alongside signResolve.ts's beat, not after it -- "instant
 * results while the constellation resolves," per the project owner. Appends
 * its own wrapper into `container` rather than replacing its contents
 * outright -- the still-resolving constellation (signResolve.ts's starfield)
 * stays lit underneath, and the result itself (not the Again link) overlays
 * it at 50% opacity.
 */
import { explainDisclaimer, explainVerdict } from "../../explain";
import type { OracleOutcome } from "../../oracle";
import { requireElementOfType } from "../dom";
import { headlineFor, thumbDirectionFor, type ThumbDirection } from "../copy";
import { renderGlyph, type GlyphName } from "../glyphs";

const GLYPH_FOR_DIRECTION: Record<ThumbDirection, GlyphName> = {
  up: "thumbUp",
  down: "thumbDown",
  sideways: "thumbSideways",
};

export async function runVerdictResolveBeat(
  container: HTMLElement,
  outcome: Extract<OracleOutcome, { kind: "verdict" }>,
  activityText: string,
  opts: { onAgain: () => void },
): Promise<void> {
  // Static markup only (no user data interpolated here); the justification
  // sentence below is set via textContent, never innerHTML, since it embeds
  // the user's own activity text.
  const wrapper = document.createElement("div");
  wrapper.className = "verdict-resolve-beat";
  wrapper.innerHTML = `
    <div class="verdict-resolve-result">
      <div id="verdict-glyph-host" class="verdict-resolve-glyph"></div>
      <h2 id="verdict-headline" class="verdict-resolve-headline"></h2>
      <p id="verdict-justification" class="verdict-resolve-justification"></p>
    </div>
    <div id="verdict-again-host"></div>
  `;
  container.append(wrapper);

  const glyphHost = requireElementOfType("verdict-glyph-host", HTMLDivElement);
  const headline = requireElementOfType("verdict-headline", HTMLHeadingElement);
  const justification = requireElementOfType("verdict-justification", HTMLParagraphElement);
  const againHost = requireElementOfType("verdict-again-host", HTMLDivElement);

  renderGlyph(glyphHost, GLYPH_FOR_DIRECTION[thumbDirectionFor(outcome.favor)]);
  headline.textContent = headlineFor(outcome.favor);
  justification.textContent = explainVerdict(outcome, activityText);

  // Same visibly-separate-element pattern as the pre-overhaul UI
  // (sequencer.ts's old `renderVerdict`): reuse `.verdict-disclaimer` rather
  // than inventing a new class, since the disclaimer's look isn't changing,
  // only where it's mounted.
  const disclaimerText = explainDisclaimer(outcome);
  if (disclaimerText !== undefined) {
    const disclaimer = document.createElement("p");
    disclaimer.className = "verdict-disclaimer";
    disclaimer.textContent = disclaimerText;
    justification.after(disclaimer);
  }

  // A plain link-styled button (per the project owner: "change the again
  // button to be a link, no brownie sprinkles" -- this replaced an earlier
  // literal-sprinkle-lettering button, sprinkleAgainButton.ts, now deleted).
  const againButton = document.createElement("button");
  againButton.type = "button";
  againButton.className = "again-link";
  againButton.textContent = "Again";
  againButton.addEventListener("click", () => {
    opts.onAgain();
  });
  againHost.append(againButton);
}
