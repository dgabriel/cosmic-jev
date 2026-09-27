/**
 * Explanation templating (oracle-zqz): `OracleOutcome` -> deadpan copy, and
 * `NatalChart` -> ambiguity notices. Pure functions, no DOM, no I/O -- easy
 * to unit test in isolation from src/main.ts's rendering code.
 *
 * Every word here is either a fixed template string or drawn from typed
 * fields the app already computed elsewhere (oracle.ts's `OracleOutcome`,
 * natal.ts's `NatalChart`, aspects.ts's `Aspect`): no LLM-generated or
 * scraped text, per the project's hard rule. See docs/spec.md section 3 for
 * the example sentence shape this follows.
 */
import type { Aspect } from "./aspects";
import type { NatalChart } from "./natal";
import type { OracleOutcome } from "./oracle";

/** Exact wording from docs/spec.md section 2's routing description. */
export const RECUSAL_MESSAGE = "The stars recuse themselves from this one.";

/**
 * Shown alongside the explanation whenever `OracleOutcome`'s `disclaimer`
 * flag is true (oracle-2au): health, money, relationship_ending, and
 * job_quitting all proceed to a real verdict, but the app still wants to be
 * visibly clear it isn't real advice. One generic line rather than four
 * per-bucket-flavored ones -- `OracleOutcome`'s verdict variant only carries
 * a `disclaimer: boolean`, not which `SensitivityCategory` triggered it (see
 * oracle.ts), so a single line that reads sensibly for all four is simpler
 * to write and maintain than plumbing the specific bucket all the way
 * through just for copy. Deadpan/light tone to match the rest of the app,
 * but unambiguous that this isn't real advice.
 */
export const DISCLAIMER_MESSAGE =
  "This one touches something that actually matters. The stars will still weigh in, but please also talk to an actual doctor, financial advisor, therapist, or other qualified human -- whichever applies -- before doing anything based on a planetary alignment.";

/**
 * Own wording (spec leaves the exact phrasing to the UI, section 3):
 * deadpan, asks for more detail, shows no verdict or probability.
 */
export const NEEDS_DETAIL_MESSAGE =
  "That's too vague for the stars to work with. Describe the activity a bit more specifically and ask again.";

/** Exact wording from docs/spec.md section 3's cusp-ambiguity example (the natal Sun). */
export const CUSP_MESSAGE = "Born on a cusp. Add a birth time to settle it.";

/**
 * Own wording (spec leaves this to us) for the natal Moon's cusp ambiguity,
 * which is common per docs/spec.md section 1 ("frequent Moon ambiguity") and
 * has a real, silent consequence today: `computeAspects` (aspects.ts) drops
 * the natal-Moon aspect from the aspect list entirely whenever the Moon is
 * ambiguous, with no notice otherwise -- this message is that notice, named
 * distinctly from `CUSP_MESSAGE` (rather than reused verbatim) so it can
 * call out the dropped aspect and so both can be shown together, undiluted,
 * when the Sun and Moon are both ambiguous on the same birthdate.
 */
export const MOON_CUSP_MESSAGE =
  "The Moon is also born on a cusp: its sign is uncertain, so any natal-Moon aspect is left out of the explanation below until a birth time settles it.";

export type Firmness = "Firmly" | "Tentatively";

/**
 * "Firmly" vs "Tentatively" cutoff: distance from 0.5 >= 0.2 reads as
 * "Firmly" (i.e. favor <= 0.3 or favor >= 0.7); anything closer to 0.5 reads
 * as "Tentatively". The spec specifies only "based on distance from 0.5" and
 * leaves the exact cutoff to us; this value is documented here so it's easy
 * to find and reconsider. It agrees with the spec's own example: p = 0.81
 * (distance 0.31) is "Firmly".
 */
export const FIRMNESS_DISTANCE_THRESHOLD = 0.2;

/**
 * A tiny epsilon so exact-boundary values (e.g. favor = 0.7, whose distance
 * from 0.5 is 0.19999999999999996 in IEEE 754 double arithmetic, not exactly
 * 0.2) still land on the "Firmly" side of the cutoff they conceptually sit
 * on, rather than being tipped to "Tentatively" by float rounding noise.
 */
const FIRMNESS_EPSILON = 1e-9;

export function firmnessFor(favor: number): Firmness {
  return Math.abs(favor - 0.5) >= FIRMNESS_DISTANCE_THRESHOLD - FIRMNESS_EPSILON ? "Firmly" : "Tentatively";
}

/** 👍 for favor >= 0.5, 👎 otherwise -- the same 0.5 midpoint `firmnessFor` measures distance from. */
export function emojiFor(favor: number): "👍" | "👎" {
  return favor >= 0.5 ? "👍" : "👎";
}

function capitalize(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/**
 * "trine your natal Sun", or "trine your natal Sun and sextile your natal
 * Moon" for however many aspects are present (0, 1, or several -- in
 * practice at most one per natal point, i.e. at most 2 for Sun+Moon, since
 * `computeAspects` returns at most one aspect per transit/natal-point pair).
 * Returns "" for a zero-aspect list so callers can omit the clause entirely
 * rather than force an empty description into the sentence.
 */
function describeAspects(aspects: readonly Aspect[]): string {
  if (aspects.length === 0) return "";
  const phrases = aspects.map((aspect) => `${aspect.aspect} your natal ${aspect.natal}`);
  const last = phrases[phrases.length - 1] ?? "";
  if (phrases.length === 1) return last;
  return `${phrases.slice(0, -1).join(", ")} and ${last}`;
}

/**
 * Renders the full deadpan verdict sentence, following docs/spec.md section
 * 3's example shape: "{Activity} is ruled by {body}. {Body} is
 * {direct/retrograde} in {sign}[, {aspect list}]. The cosmos
 * {endorses/is skeptical of} this (p = {favor}). {Firmly/Tentatively} {emoji}."
 */
export function explainVerdict(
  outcome: Extract<OracleOutcome, { kind: "verdict" }>,
  activityText: string,
): string {
  const { category, rulingBodyTransit, aspects, favor } = outcome;
  const motion = rulingBodyTransit.retrograde ? "retrograde" : "direct";
  const aspectSummary = describeAspects(aspects);
  const positionSentence = aspectSummary
    ? `${category} is ${motion} in ${rulingBodyTransit.sign}, ${aspectSummary}.`
    : `${category} is ${motion} in ${rulingBodyTransit.sign}.`;
  const verdictWord = favor >= 0.5 ? "endorses" : "is skeptical of";
  const firmness = firmnessFor(favor);
  const emoji = emojiFor(favor);

  return [
    `${capitalize(activityText)} is ruled by ${category}.`,
    positionSentence,
    `The cosmos ${verdictWord} this (p = ${favor.toFixed(2)}).`,
    `${firmness} ${emoji}.`,
  ].join(" ");
}

/**
 * Renders any `OracleOutcome` to its deadpan copy: the exact fixed strings
 * for recusal/needs-detail (which structurally carry no probability or
 * verdict to leak), or the templated verdict sentence.
 */
export function explainOutcome(outcome: OracleOutcome, activityText: string): string {
  switch (outcome.kind) {
    case "recusal":
      return RECUSAL_MESSAGE;
    case "needs-detail":
      return NEEDS_DETAIL_MESSAGE;
    case "verdict":
      return explainVerdict(outcome, activityText);
  }
}

/**
 * `DISCLAIMER_MESSAGE` when `outcome` is a disclaimer-flagged verdict,
 * `undefined` otherwise -- so the UI (main.ts) can render it as its own,
 * visibly separate element alongside (not folded into) the main explanation
 * sentence.
 */
export function explainDisclaimer(outcome: OracleOutcome): string | undefined {
  if (outcome.kind === "verdict" && outcome.disclaimer) {
    return DISCLAIMER_MESSAGE;
  }
  return undefined;
}

/**
 * Ambiguity messaging, independent of the oracle outcome: it's about the
 * natal chart itself, not the day's verdict. Returns:
 *  - the exact Sun-cusp wording from spec section 3 when the natal Sun's
 *    sign is uncertain (`ambiguous: true`, i.e. no birth time given and the
 *    sign changed that day);
 *  - `MOON_CUSP_MESSAGE` when the natal Moon's sign is likewise uncertain
 *    (spec section 1 calls this the frequent case) -- checked independently
 *    of the Sun, so a chart with both ambiguous gets both messages rather
 *    than one silently winning; they read as distinct notices, not
 *    near-duplicates, since the Moon one also calls out the dropped aspect;
 *  - plus -- the spec leaves this to us ("adapt similarly if you want to
 *    also mention Ascendant unreliability") -- a note when the Ascendant was
 *    computed but flagged numerically unreliable (near-polar birth
 *    locations).
 *
 * Deliberately does NOT add a message for `ascendant.status ===
 * "not-computed"`: that's the ordinary, expected state whenever the
 * optional birth time/location fields are simply left blank, not a warning
 * worth surfacing the way a cusp or an unreliable result is.
 *
 * Returns an empty array when there is nothing to flag.
 */
export function explainAmbiguity(natal: NatalChart): string[] {
  const messages: string[] = [];
  if (natal.bodies.Sun.ambiguous) {
    messages.push(CUSP_MESSAGE);
  }
  if (natal.bodies.Moon.ambiguous) {
    messages.push(MOON_CUSP_MESSAGE);
  }
  if (natal.ascendant.status === "unreliable") {
    messages.push(`Ascendant unreliable: ${natal.ascendant.reason}`);
  }
  return messages;
}
