/**
 * Oracle (oracle-cne): the `Oracle` interface (Call 1 classify + Call 2
 * verdict), the consequential/vague routing logic shared by every
 * implementation, and `StubOracle`, a deterministic local stand-in for the
 * real `JevOracle` (oracle-rwy, not yet implemented -- see `createOracle`
 * below, which throws rather than faking one).
 *
 * Reuses sky.ts/aspects.ts/natal.ts types rather than re-inventing chart
 * shapes: `BodyPosition`, `MoonPhaseName`, `TransitBodyName`, `TransitChart`
 * from ./sky, `Aspect`/`computeAspects` from ./aspects, `NatalChart` from
 * ./natal.
 *
 * Per docs/jev-openrouter.md, Jev's three question types are Noul (a
 * probability of "yes"), Choice (a top option plus per-option
 * probabilities), and Score (a 0-indexed, probability-weighted position on a
 * scale, normalized to [0, 1] via `score / (levels - 1)`). This module
 * models only the *shape* of the answers the oracle cares about (a plain
 * probability number and an already-normalized 0-1 "intensity"); the fuller
 * response parsing (confidence, per-option probabilities, request/response
 * wiring to OpenRouter) is oracle-rwy's concern.
 *
 * No LLM-generated or scraped prose anywhere in this module: every output
 * is typed data for oracle-zqz to template into deadpan copy, never text
 * itself.
 */
import { computeAspects, type Aspect } from "./aspects";
import type { OracleKind } from "./config";
import type { NatalChart } from "./natal";
import { TRANSIT_BODIES, type BodyPosition, type MoonPhaseName, type TransitBodyName, type TransitChart } from "./sky";

/**
 * The seven ruling bodies a Call 1 Choice question picks among. Identical to
 * `TransitBodyName` (every transit body doubles as a possible ruling body,
 * per spec section 2's category list) -- aliased rather than redeclared so
 * the two stay in lockstep and so oracle call sites read as "which body
 * rules this activity" rather than "which of the seven tracked bodies".
 */
export type RulingBody = TransitBodyName;

/** A Noul answer's value: probability of "yes", in [0, 1] (docs/jev-openrouter.md's `noul` type). */
export type Noul = number;

/**
 * A Score answer already normalized to [0, 1] ("cosmic intensity"), per
 * docs/jev-openrouter.md: `score / (levels - 1)`, where `score` is Jev's
 * raw 0-indexed, probability-weighted position on an N-level scale. This
 * module only ever sees the normalized value; the real `JevOracle` (not
 * implemented here) is responsible for doing that division when parsing
 * OpenRouter's response.
 */
export type Intensity = number;

/** Call 1's result: the activity's category (ruling body) and the two routing Nouls. */
export interface ClassificationResult {
  category: RulingBody;
  /** "Is this a consequential real-life decision?" (health, money, legal, safety, ...). */
  consequential: Noul;
  /** "Is this activity description too vague to categorize?" */
  vague: Noul;
}

/**
 * Call 2's input: everything the spec lists as Call 2's `state` --
 * "category, ruling body's transit position and retrograde status, relevant
 * aspect list, Moon phase, the activity text" -- typed rather than
 * flattened into a prose blob, so a real `JevOracle` can serialize it
 * however OpenRouter's `state` field wants and `StubOracle` can read it
 * directly.
 */
export interface VerdictInput {
  category: RulingBody;
  /** The ruling body's current transit position (includes its retrograde status). */
  rulingBodyTransit: BodyPosition;
  /** Aspects from the ruling body's transit to the natal Sun/Moon (i.e. "relevant" to it). */
  aspects: Aspect[];
  moonPhase: MoonPhaseName;
  activityText: string;
}

/** Call 2's result: the favor Noul and the intensity Score, batched in one call per the docs. */
export interface VerdictAnswer {
  /** "Do the stars favor this activity for this person today?" */
  favor: Noul;
  intensity: Intensity;
}

/**
 * Shared shape for every oracle implementation (`StubOracle` here;
 * `JevOracle` in oracle-rwy). Two methods, one per Jev call, so routing
 * (below) can call `classify` alone and only invoke `verdict` when routing
 * actually proceeds to Call 2.
 */
export interface Oracle {
  /** Call 1: classify the activity text alone (state = activity text only, per spec). */
  classify(activityText: string): Promise<ClassificationResult>;
  /** Call 2: the verdict, given the routed category and its supporting typed context. */
  verdict(input: VerdictInput): Promise<VerdictAnswer>;
}

/**
 * Routing thresholds from docs/spec.md section 2. These are a safety
 * feature (consequential decisions never get a verdict; vague ones get
 * asked to clarify instead of a guess) -- do not change them without
 * checking with the project owner first.
 */
export const CONSEQUENTIAL_THRESHOLD = 0.3;
export const VAGUE_THRESHOLD = 0.6;

/**
 * The routing decision derived from a Call 1 classification, per spec:
 * consequential p >= CONSEQUENTIAL_THRESHOLD wins even if vague is also
 * high (recusing is the safer failure mode for a decision that might matter
 * -- asking "could you be more specific" about whether to see a doctor is
 * not the point), otherwise vague p >= VAGUE_THRESHOLD asks for detail,
 * otherwise Call 2 proceeds under `category`.
 */
export type RoutingDecision =
  | { kind: "recusal" }
  | { kind: "needs-detail" }
  | { kind: "proceed"; category: RulingBody };

/**
 * Pure routing function (no I/O, no oracle call) so both `StubOracle` and
 * the future `JevOracle` share the exact same decision logic instead of
 * each re-implementing the threshold comparisons.
 */
export function route(classification: ClassificationResult): RoutingDecision {
  if (classification.consequential >= CONSEQUENTIAL_THRESHOLD) {
    return { kind: "recusal" };
  }
  if (classification.vague >= VAGUE_THRESHOLD) {
    return { kind: "needs-detail" };
  }
  return { kind: "proceed", category: classification.category };
}

/**
 * The oracle's overall outcome, as a discriminated union so a "recusal" or
 * "needs-detail" outcome cannot carry (and so cannot accidentally surface) a
 * verdict or a probability: per spec, those two outcomes show neither. Only
 * `"verdict"` carries the favor probability and intensity, alongside enough
 * typed data (ruling body transit, its retrograde status, the relevant
 * aspect list, Moon phase) for oracle-zqz's later templating -- reusing
 * sky.ts/aspects.ts types rather than re-deriving prose-ready strings here.
 */
export type OracleOutcome =
  | { kind: "recusal" }
  | { kind: "needs-detail" }
  | {
      kind: "verdict";
      category: RulingBody;
      rulingBodyTransit: BodyPosition;
      aspects: Aspect[];
      moonPhase: MoonPhaseName;
      favor: Noul;
      intensity: Intensity;
    };

/** Everything `askOracle` needs beyond the `Oracle` implementation itself. */
export interface OracleContext {
  transits: TransitChart;
  natal: NatalChart;
  activityText: string;
}

/**
 * Runs the full Call 1 -> route -> (maybe) Call 2 flow against any `Oracle`
 * implementation, producing a typed `OracleOutcome`. This is the one place
 * that wires `route`'s decision to an actual `verdict` call and to the
 * "relevant aspect list" (aspects from the ruling body's transit to the
 * natal Sun/Moon, via `computeAspects`, filtered to that one transiting
 * body) -- so oracle-zqz and any future `Oracle` implementation share this
 * orchestration instead of re-deriving it.
 */
export async function askOracle(oracle: Oracle, context: OracleContext): Promise<OracleOutcome> {
  const classification = await oracle.classify(context.activityText);
  const decision = route(classification);

  if (decision.kind === "recusal") {
    return { kind: "recusal" };
  }
  if (decision.kind === "needs-detail") {
    return { kind: "needs-detail" };
  }

  const category = decision.category;
  const rulingBodyTransit = context.transits.bodies[category];
  const moonPhase = context.transits.moonPhase;
  const aspects = computeAspects(context.transits, context.natal).filter(
    (aspect) => aspect.transit === category,
  );

  const verdictAnswer = await oracle.verdict({
    category,
    rulingBodyTransit,
    aspects,
    moonPhase,
    activityText: context.activityText,
  });

  return {
    kind: "verdict",
    category,
    rulingBodyTransit,
    aspects,
    moonPhase,
    favor: verdictAnswer.favor,
    intensity: verdictAnswer.intensity,
  };
}

// ---------------------------------------------------------------------------
// StubOracle: deterministic, seeded from (activity text) for Call 1 and from
// (activity text + the Call 2 typed context) for Call 2 -- never
// Math.random()/Date.now(). See hashToUnitInterval below for the mechanism.
// ---------------------------------------------------------------------------

/**
 * Deterministic FNV-1a (32-bit) string hash, mapped to [0, 1). This is
 * StubOracle's entire source of "randomness": a pure function of its input
 * string, so the same string always produces the same number, run to run
 * and process to process. Different "salt" suffixes (e.g. `${text}|vague`
 * vs `${text}|consequential`) are used at each call site below to get
 * independent-looking values out of the same underlying text without
 * actually being independent of it (determinism requires that).
 */
function hashToUnitInterval(input: string): number {
  let hash = 0x811c9dc5; // FNV-1a 32-bit offset basis
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV-1a 32-bit prime
  }
  return (hash >>> 0) / 0x100000000;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Keyword lists for the Call 1 category (ruling body) heuristic, transcribed
 * directly from docs/spec.md section 2's category -> ruling body list. This
 * is deliberately simple substring matching, not real classification --
 * spec's own framing is that real classification intelligence is Jev's job
 * in `JevOracle`; this only needs to be "sensible" and deterministic.
 */
const CATEGORY_KEYWORDS: Record<RulingBody, readonly string[]> = {
  Mars: [
    "sport",
    "exercise",
    "workout",
    "work out",
    "gym",
    "run",
    "jog",
    "competition",
    "compete",
    "race",
    "confront",
    "argument",
    "fight",
    "new start",
    "bold",
  ],
  Venus: [
    "romance",
    "romantic",
    "date",
    "dating",
    "art",
    "beauty",
    "fashion",
    "socializ",
    "social",
    "party",
    "treat",
    "dessert",
    "spa",
    "friend",
  ],
  Mercury: [
    "communicat",
    "writ",
    "email",
    "e-mail",
    "short trip",
    "commute",
    "tech",
    "contract",
    "sign",
    "text",
    "phone call",
    "meeting",
  ],
  Jupiter: [
    "learn",
    "study",
    "class",
    "course",
    "long trip",
    "long travel",
    "abroad",
    "vacation",
    "gamble",
    "gambling",
    "lottery",
    "casino",
    "celebrat",
    "graduation",
  ],
  Saturn: [
    "work",
    "chore",
    "commitment",
    "commit to",
    "long-term",
    "long term",
    "plan",
    "budget",
    "deadline",
    "job",
    "career",
    "discipline",
  ],
  Moon: [
    "home",
    "cook",
    "family",
    "rest",
    "relax",
    "self-care",
    "self care",
    "nap",
    "sleep",
    "laundry",
    "clean the house",
  ],
  Sun: [
    "perform",
    "creative",
    "self-expression",
    "self expression",
    "spotlight",
    "center of attention",
    "stage",
    "showcase",
    "present",
  ],
} as const;

/**
 * Keywords for the "is this consequential?" Noul, transcribed from spec's
 * parenthetical: health, medication, money, legal, safety, ending a
 * relationship, quitting a job.
 *
 * "illegal" is listed as its own entry (not left to substring-match inside
 * "legal") because `keywordRegex` below requires a *leading* word boundary:
 * "illegal" no longer matches via "legal" embedded mid-word, so it needs an
 * explicit entry to keep being recognized as consequential.
 */
const CONSEQUENTIAL_KEYWORDS: readonly string[] = [
  "health",
  "medicat",
  "medicine",
  "surgery",
  "diagnos",
  "money",
  "invest",
  "loan",
  "mortgage",
  "savings",
  "debt",
  "legal",
  "illegal",
  "lawsuit",
  "lawyer",
  "sue",
  "safety",
  "dangerous",
  "unsafe",
  "break up",
  "breakup",
  "divorce",
  "end our relationship",
  "end my relationship",
  "end the relationship",
  "quit my job",
  "quit her job",
  "quit his job",
  "quit their job",
  "quitting my job",
  "resign",
];

/**
 * Word-boundary-aware keyword matching (reviewer-flagged bug in oracle-cne
 * review): plain substring `.includes()` let short keywords match embedded
 * inside unrelated words -- "sue" inside "issue"/"pursue"/"tissue"/"ensue",
 * "run" inside "brunch", "sign" inside "design"/"assign", "text" inside
 * "context". `keywordRegex` requires at least a *leading* word boundary
 * (`\b`) before every keyword, which blocks all of the mid-word cases above
 * while still allowing deliberate suffix stemming (no trailing boundary by
 * default): "communicat" still matches "communication", "sport" still
 * matches "sporty", "sue" still matches "sued"/"suing".
 *
 * A leading boundary alone does not catch the rarer case where the keyword
 * is a real, unrelated word's actual *prefix* -- "significant" genuinely
 * starts with "sign"; "texture"/"textile" start with "text";
 * "plane"/"planet" start with "plan"; "classic" starts with "class";
 * "investigate" starts with "invest". `PREFIX_EXCLUDES` adds a per-keyword
 * negative lookahead for exactly those known collisions (found while
 * rechecking the lists for this same bug class), so each keyword still
 * stems normally everywhere else. `WHOLE_WORD_KEYWORDS` covers a second,
 * smaller case: "spa" and "rest" are each a common prefix of several
 * unrelated words ("space"/"spare"/"spark...", "restaurant"/"restore"/
 * "result"/"restrict") with no valuable stemmed form worth preserving, so
 * they require a full word match instead of a prefix match.
 */
const PREFIX_EXCLUDES: Readonly<Record<string, readonly string[]>> = {
  sign: ["ificant"], // "significant"
  text: ["ure", "ile"], // "texture", "textile"
  plan: ["e", "kton"], // "plane"/"planet"/"planer", "plankton"
  class: ["ic"], // "classic"/"classical"
  invest: ["igat"], // "investigate"/"investigation"
};

const WHOLE_WORD_KEYWORDS: ReadonlySet<string> = new Set(["spa", "rest"]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function keywordRegex(keyword: string): RegExp {
  const escaped = escapeRegExp(keyword);
  if (WHOLE_WORD_KEYWORDS.has(keyword)) {
    return new RegExp(`\\b${escaped}\\b`);
  }
  const excludedSuffixes = PREFIX_EXCLUDES[keyword];
  if (excludedSuffixes) {
    const alternation = excludedSuffixes.map(escapeRegExp).join("|");
    return new RegExp(`\\b${escaped}(?!${alternation})`);
  }
  return new RegExp(`\\b${escaped}`);
}

function countKeywordMatches(lowerText: string, keywords: readonly string[]): number {
  let count = 0;
  for (const keyword of keywords) {
    if (keywordRegex(keyword).test(lowerText)) count++;
  }
  return count;
}

/**
 * Safe indexed read into `TRANSIT_BODIES` for a computed (non-literal)
 * index, satisfying `noUncheckedIndexedAccess` the same way natal.ts's `at`
 * helper does for its rotation matrix reads.
 */
function bodyAtIndex(index: number): RulingBody {
  const body = TRANSIT_BODIES[index];
  if (body === undefined) {
    throw new Error(`TRANSIT_BODIES index out of range: ${index}`);
  }
  return body;
}

/**
 * Picks the best-matching ruling body by keyword count (ties broken by
 * `TRANSIT_BODIES`'s fixed order, so the result is deterministic even when
 * two bodies tie). When nothing matches at all, falls back to a
 * hash-derived pick among all seven -- Jev's Choice answers always name a
 * top option even under low confidence (per docs/jev-openrouter.md), so a
 * real "no idea" case should not collapse to always guessing the same body.
 */
function pickCategory(lowerText: string): { body: RulingBody; matched: boolean } {
  let best: RulingBody | undefined;
  let bestCount = 0;
  for (const body of TRANSIT_BODIES) {
    const count = countKeywordMatches(lowerText, CATEGORY_KEYWORDS[body]);
    if (count > bestCount) {
      bestCount = count;
      best = body;
    }
  }
  if (best !== undefined) {
    return { body: best, matched: true };
  }
  const index = Math.floor(hashToUnitInterval(`${lowerText}|category-fallback`) * TRANSIT_BODIES.length);
  return { body: bodyAtIndex(Math.min(index, TRANSIT_BODIES.length - 1)), matched: false };
}

/**
 * Deterministic "is this consequential?" probability: a high band (0.7-0.85)
 * when a consequential keyword is present, a low band (0.05-0.2) otherwise.
 * The jitter within each band comes from the hash, not the keyword match, so
 * two different mundane activities still get two different (both low)
 * numbers rather than an identical constant.
 */
function classifyConsequential(lowerText: string): Noul {
  const matched = CONSEQUENTIAL_KEYWORDS.some((keyword) => keywordRegex(keyword).test(lowerText));
  const jitter = hashToUnitInterval(`${lowerText}|consequential-jitter`) * 0.15;
  return matched ? clamp01(0.7 + jitter) : clamp01(0.05 + jitter);
}

/**
 * Deterministic "is this too vague?" probability: high when no category
 * keyword matched at all, or the text is very short (<= 2 words); low
 * otherwise. Jittered the same way as `classifyConsequential`.
 */
function classifyVague(lowerText: string, categoryMatched: boolean): Noul {
  const wordCount = lowerText.split(/\s+/).filter((word) => word.length > 0).length;
  const jitter = hashToUnitInterval(`${lowerText}|vague-jitter`) * 0.15;
  if (!categoryMatched || wordCount <= 2) {
    return clamp01(0.75 + jitter);
  }
  return clamp01(0.1 + jitter);
}

/** Call 1's stub implementation: pure function of the activity text alone. */
function stubClassify(activityText: string): ClassificationResult {
  const lowerText = activityText.trim().toLowerCase();
  const { body: category, matched } = pickCategory(lowerText);
  return {
    category,
    consequential: classifyConsequential(lowerText),
    vague: classifyVague(lowerText, matched),
  };
}

/**
 * Builds a stable seed string from every field of `VerdictInput` (so the
 * verdict is deterministic in the chart data too, not just the activity
 * text -- two identical activity strings under two different transits/
 * aspects/Moon phases should not force the same verdict).
 */
function verdictSeed(input: VerdictInput): string {
  const aspectsKey = input.aspects
    .map((aspect) => `${aspect.transit}-${aspect.natal}-${aspect.aspect}-${aspect.orb.toFixed(2)}-${aspect.applying}`)
    .join(",");
  return [
    input.category,
    input.rulingBodyTransit.sign,
    input.rulingBodyTransit.degreeInSign.toFixed(2),
    input.rulingBodyTransit.retrograde,
    input.moonPhase,
    aspectsKey,
    input.activityText.trim().toLowerCase(),
  ].join("|");
}

/**
 * A small, deterministic nudge from the aspect list: harmonious aspects
 * (trine, sextile) push favor up, hard aspects (square, opposition) push it
 * down, weighted more heavily when applying (tightening) than separating.
 * Conjunction is treated as neutral -- traditionally it blends with whatever
 * it touches rather than reading as consistently harmonious or hard.
 */
function harmonicAdjustment(aspects: readonly Aspect[]): number {
  let adjustment = 0;
  for (const aspect of aspects) {
    const weight = aspect.applying ? 1 : 0.5;
    if (aspect.aspect === "trine" || aspect.aspect === "sextile") {
      adjustment += 0.05 * weight;
    } else if (aspect.aspect === "square" || aspect.aspect === "opposition") {
      adjustment -= 0.05 * weight;
    }
  }
  return adjustment;
}

/** Call 2's stub implementation: pure function of the full typed verdict input. */
function stubVerdict(input: VerdictInput): VerdictAnswer {
  const seed = verdictSeed(input);

  const favorBase = hashToUnitInterval(`${seed}|favor`);
  const retrogradeAdjustment = input.rulingBodyTransit.retrograde ? -0.1 : 0;
  const favor = clamp01(favorBase + harmonicAdjustment(input.aspects) + retrogradeAdjustment);

  const intensityBase = hashToUnitInterval(`${seed}|intensity`);
  const aspectCountBoost = Math.min(input.aspects.length * 0.05, 0.2);
  const moonPhaseBoost = input.moonPhase === "full" || input.moonPhase === "new" ? 0.1 : 0;
  const intensity = clamp01(intensityBase + aspectCountBoost + moonPhaseBoost);

  return { favor, intensity };
}

/**
 * Deterministic local stand-in for `JevOracle` (oracle-rwy): same shape as
 * `Oracle`, no network calls, seeded entirely from its inputs (activity
 * text for Call 1; activity text + chart data for Call 2). Lets the app run
 * without an API key and keeps tests stable.
 */
export class StubOracle implements Oracle {
  classify(activityText: string): Promise<ClassificationResult> {
    return Promise.resolve(stubClassify(activityText));
  }

  verdict(input: VerdictInput): Promise<VerdictAnswer> {
    return Promise.resolve(stubVerdict(input));
  }
}

/**
 * Constructs the `Oracle` selected by `VITE_ORACLE` (see src/config.ts's
 * `ORACLE_KIND`/`parseOracleKind`). `JevOracle` is oracle-rwy, a separate
 * issue depending on this one and on the deployed Worker -- it does not
 * exist yet, so `"jev"` throws an explicit, honest error rather than a fake
 * implementation (a placeholder `JevOracle` that silently behaved like the
 * stub would be worse than no implementation at all).
 */
export function createOracle(kind: OracleKind): Oracle {
  switch (kind) {
    case "stub":
      return new StubOracle();
    case "jev":
      throw new Error(
        "JevOracle is not yet implemented (bd oracle-rwy). Set VITE_ORACLE=stub, or implement oracle-rwy first.",
      );
  }
}
