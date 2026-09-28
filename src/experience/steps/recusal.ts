/**
 * Recusal beat: pray-hands emoji + the "stars recommend therapy" copy + an
 * "Again" affordance. Mounted right alongside signResolve.ts's beat, not
 * after it -- "instant results while the constellation resolves," per the
 * project owner -- as an alternate ending to the same verdict-or-recusal
 * branch, not a different opening. Appends its own wrapper into `container`
 * rather than replacing its contents outright -- the still-resolving
 * constellation stays lit underneath, and the result itself (not the Again
 * link) overlays it at 50% opacity, matching verdictResolve.ts.
 */
import { RECUSAL_MESSAGE } from "../../explain";
import { requireElementOfType } from "../dom";
import { renderGlyph } from "../glyphs";

export async function runRecusalBeat(container: HTMLElement, opts: { onAgain: () => void }): Promise<void> {
  const wrapper = document.createElement("div");
  wrapper.className = "recusal-beat";
  wrapper.innerHTML = `
    <div class="recusal-result">
      <div id="recusal-glyph-host" class="recusal-glyph"></div>
      <p id="recusal-message" class="recusal-message"></p>
    </div>
    <div id="recusal-again-host"></div>
  `;
  container.append(wrapper);

  const glyphHost = requireElementOfType("recusal-glyph-host", HTMLDivElement);
  const message = requireElementOfType("recusal-message", HTMLParagraphElement);
  const againHost = requireElementOfType("recusal-again-host", HTMLDivElement);

  renderGlyph(glyphHost, "prayHands");
  message.textContent = RECUSAL_MESSAGE;

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
