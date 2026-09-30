/**
 * Recusal beat: pray-hands emoji + the "stars recommend therapy" copy,
 * appended into the result area that replaces the intake form -- the
 * alternate ending to verdictResolve.ts's beat (the sequencer adds the sign
 * name and the "Again" link after either one).
 */
import { RECUSAL_MESSAGE } from "../../explain";
import { requireElementOfType } from "../dom";
import { renderGlyph } from "../glyphs";

export async function runRecusalBeat(container: HTMLElement): Promise<void> {
  const wrapper = document.createElement("div");
  wrapper.className = "recusal-beat";
  wrapper.innerHTML = `
    <div class="recusal-result">
      <div id="recusal-glyph-host" class="recusal-glyph"></div>
      <p id="recusal-message" class="recusal-message"></p>
    </div>
  `;
  container.append(wrapper);

  const glyphHost = requireElementOfType("recusal-glyph-host", HTMLDivElement);
  const message = requireElementOfType("recusal-message", HTMLParagraphElement);

  renderGlyph(glyphHost, "prayHands");
  message.textContent = RECUSAL_MESSAGE;
}
