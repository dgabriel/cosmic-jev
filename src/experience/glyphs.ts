/**
 * Standard Unicode emoji for the verdict/recusal beats' thumb/pray-hands
 * glyphs -- replaces an earlier hand-authored pixel-art bitmap version
 * (oracle-sv9.10) per explicit project-owner feedback asking for the real
 * emoji instead. There is no standalone "sideways thumb" emoji in Unicode:
 * `../copy.ts`'s "sideways" direction (tentative confidence, per the
 * bar-napkin spec's "up or down (or sideways)") is rendered as a thumbs-up
 * rotated 90°, the same physical gesture turned sideways, rather than an
 * unrelated symbol.
 */
export type GlyphName = "thumbUp" | "thumbDown" | "thumbSideways" | "prayHands";

const EMOJI: Record<GlyphName, string> = {
  thumbUp: "👍",
  thumbDown: "👎",
  thumbSideways: "👍",
  prayHands: "🙏",
};

const ARIA_LABEL: Record<GlyphName, string> = {
  thumbUp: "thumbs up",
  thumbDown: "thumbs down",
  thumbSideways: "thumb sideways, uncertain",
  prayHands: "praying hands",
};

/**
 * Renders `name`'s emoji into `container` as a single `<span>`, clearing any
 * previous contents first so re-invoking this (e.g. on "Again" replay) never
 * stacks up duplicate spans.
 */
export function renderGlyph(container: HTMLElement, name: GlyphName): HTMLSpanElement {
  container.replaceChildren();

  const span = document.createElement("span");
  span.className = "beat-glyph";
  if (name === "thumbSideways") {
    span.classList.add("beat-glyph--sideways");
  }
  span.setAttribute("role", "img");
  span.setAttribute("aria-label", ARIA_LABEL[name]);
  span.textContent = EMOJI[name];

  container.append(span);
  return span;
}
