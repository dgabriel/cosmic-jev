/**
 * "Too vague" beat (oracle-sv9.10): the bar-napkin spec has no described
 * theatrical treatment for this outcome -- no overlay, no swirl, no pixel
 * glyph -- since there's no verdict to build drama toward, so this renders
 * as a quick inline message instead of a full beat.
 */
import { NEEDS_DETAIL_MESSAGE } from "../../explain";
import { renderMessage } from "../dom";

export function renderNeedsDetailBeat(container: HTMLElement): void {
  renderMessage(container, NEEDS_DETAIL_MESSAGE, "info");
}
