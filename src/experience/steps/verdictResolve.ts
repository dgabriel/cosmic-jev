/**
 * Verdict-resolve beat: thumb emoji + headline + justification sentence,
 * appended into the result area that replaces the intake form (the sequencer
 * adds the sign name and the "Again" link after it). Shown immediately while
 * the page's starfield swirls into the constellation behind it -- "instant
 * results while the constellation resolves," per the project owner.
 */
import { explainVerdict } from "../../explain";
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
  activityText: string
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
  `;
  container.append(wrapper);

  const glyphHost = requireElementOfType("verdict-glyph-host", HTMLDivElement);
  const headline = requireElementOfType("verdict-headline", HTMLHeadingElement);
  const justification = requireElementOfType("verdict-justification", HTMLParagraphElement);

  renderGlyph(glyphHost, GLYPH_FOR_DIRECTION[thumbDirectionFor(outcome.favor)]);
  headline.textContent = headlineFor(outcome.favor);
  justification.textContent = explainVerdict(outcome, activityText);
}
