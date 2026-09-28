/**
 * Oracle (oracle-cne, sensitivity routing redesigned in oracle-2au): the
 * `Oracle` interface (Call 1 classify + Call 2 verdict), the sensitivity/
 * vague routing logic shared by every implementation, and `StubOracle`, a
 * deterministic local stand-in for the real `JevOracle` (oracle-rwy,
 * src/oracle-jev.ts -- see `createOracle` below, which constructs it for
 * `"jev"`).
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
 * wiring to OpenRouter) is oracle-rwy's concern (src/oracle-jev.ts).
 *
 * No LLM-generated or scraped prose anywhere in this module: every output
 * is typed data for oracle-zqz to template into deadpan copy, never text
 * itself.
 */
import { computeAspects, type Aspect } from "./aspects";
import { WORKER_URL, type OracleKind } from "./config";
import type { NatalChart } from "./natal";
import { JevOracle } from "./oracle-jev";
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
 * The sensitivity bucket a Call 1 Choice question sorts the activity into
 * (oracle-2au), replacing the old single scalar "consequential" Noul. Each
 * bucket has a fixed routing behavior (see `route` below):
 * - `violence_person`: violence or harm directed at a person or animal,
 *   INCLUDING the asker harming themselves (self-harm/suicide-adjacent
 *   text). Always recuses. Checked with the highest priority of anything in
 *   `route` -- nothing overrides it into a verdict.
 * - `safety`, `legal`: always recuse, no exceptions.
 * - `health` (everything health-related EXCEPT the violence_person/self-harm
 *   case above -- self-harm is never merely "health"), `money`,
 *   `relationship_ending`, `job_quitting`: proceed to a real verdict, but
 *   flagged `disclaimer: true`.
 * - `violence_object`: violence/destruction directed at an inanimate object
 *   (e.g. "smash my printer"). Treated as a perfectly ordinary activity: no
 *   recusal, no disclaimer.
 * - `none`: not sensitive at all.
 */
export type SensitivityCategory =
  | "safety"
  | "legal"
  | "violence_person"
  | "health"
  | "money"
  | "relationship_ending"
  | "job_quitting"
  | "violence_object"
  | "none";

/**
 * A Score answer already normalized to [0, 1] ("cosmic intensity"), per
 * docs/jev-openrouter.md: `score / (levels - 1)`, where `score` is Jev's
 * raw 0-indexed, probability-weighted position on an N-level scale. This
 * module only ever sees the normalized value; the real `JevOracle` (not
 * implemented here) is responsible for doing that division when parsing
 * OpenRouter's response.
 */
export type Intensity = number;

/**
 * Call 1's result: the activity's category (ruling body), its sensitivity
 * bucket, and the vague routing Noul. `vague` stays its own independent Noul
 * (oracle-2au) -- vague-detection is orthogonal to sensitivity: an activity
 * can be simultaneously vague and (say) health-flavored, or neither, or
 * either alone.
 */
export interface ClassificationResult {
  category: RulingBody;
  /** Which sensitivity bucket the activity falls into (see `SensitivityCategory`). */
  sensitivity: SensitivityCategory;
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
 * Vague routing threshold. This is a safety feature (vague activities get
 * asked to clarify instead of a guess) -- do not change it without checking
 * with the project owner first.
 *
 * The old scalar `CONSEQUENTIAL_THRESHOLD` (p >= 0.3) is retired as of
 * oracle-2au: `route` below now switches on `SensitivityCategory` buckets
 * instead of a single probability, per explicit user-directed policy change
 * (overriding the prior "do not change thresholds without asking" note for
 * that constant specifically -- `VAGUE_THRESHOLD` is unchanged at the time).
 *
 * Raised from docs/spec.md section 2's original 0.6 to 0.75, per explicit
 * project-owner direction: real Jev (typesafe/jev-1.13) consistently scored
 * plain, ordinary activities like "Should I have a party tonight" around
 * 0.68-0.70 vague, well above 0.6, sending them to "needs-detail" when they
 * didn't need clarifying. Confirmed via direct requests against the deployed
 * Worker before changing this. `docs/spec.md` is updated to match.
 */
export const VAGUE_THRESHOLD = 0.75;

/** Why a `RoutingDecision` recused -- internal-only (tests/telemetry); the user-facing message stays generic either way (see explain.ts's `RECUSAL_MESSAGE`). */
export type RecusalReason = "violence_person" | "safety" | "legal";

/** Sensitivity buckets that always recuse, no exceptions, in priority order (highest first). */
const RECUSAL_PRIORITY: readonly RecusalReason[] = ["violence_person", "safety", "legal"];

/** Sensitivity buckets that proceed to a real verdict but flagged `disclaimer: true`. */
const DISCLAIMER_SENSITIVITIES: ReadonlySet<SensitivityCategory> = new Set([
  "health",
  "money",
  "relationship_ending",
  "job_quitting",
]);

/**
 * The routing decision derived from a Call 1 classification (oracle-2au),
 * per spec section 2's priority order (highest first):
 * `violence_person` > `safety` > `legal` > vague >= `VAGUE_THRESHOLD` >
 * proceed. `violence_person` (which covers violence/harm toward a person or
 * animal, including the asker's own self-harm) is checked before anything
 * else and nothing can override it into a verdict. `proceed` carries
 * `disclaimer: true` for `health`/`money`/`relationship_ending`/
 * `job_quitting`, and `disclaimer: false` for `violence_object`/`none`.
 */
export type RoutingDecision =
  | { kind: "recusal"; reason: RecusalReason }
  | { kind: "needs-detail" }
  | { kind: "proceed"; category: RulingBody; disclaimer: boolean };

/**
 * Pure routing function (no I/O, no oracle call) so both `StubOracle` and
 * `JevOracle` share the exact same decision logic instead of each
 * re-implementing the priority order.
 */
export function route(classification: ClassificationResult): RoutingDecision {
  for (const reason of RECUSAL_PRIORITY) {
    if (classification.sensitivity === reason) {
      return { kind: "recusal", reason };
    }
  }
  if (classification.vague >= VAGUE_THRESHOLD) {
    return { kind: "needs-detail" };
  }
  return {
    kind: "proceed",
    category: classification.category,
    disclaimer: DISCLAIMER_SENSITIVITIES.has(classification.sensitivity),
  };
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
      /**
       * True for the disclaimer-flagged sensitivity buckets (health, money,
       * relationship_ending, job_quitting -- oracle-2au): the UI renders a
       * visible disclaimer alongside the explanation for these. False for
       * violence_object/none.
       */
      disclaimer: boolean;
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
    // `decision.reason` (violence_person/safety/legal) is intentionally
    // dropped here: per spec, the user-facing recusal message stays generic
    // regardless of reason (see explain.ts's RECUSAL_MESSAGE). Callers that
    // want the reason for tests/telemetry should call `route` directly.
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
    disclaimer: decision.disclaimer,
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
 * vs `${text}|favor`) are used at each call site below to get
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
 *
 * oracle-d4i broadened these lists with common everyday-phrasing synonyms
 * that real users typed but the original lists missed entirely, sending
 * clearly-categorizable activities down the vague/needs-detail path instead
 * (`classifyVague` returns a high probability whenever no keyword matches at
 * all). Two placement calls worth noting:
 * - "clean" (as in "clean my bathroom") replaces the old exact-phrase-only
 *   "clean the house" under Moon, not Saturn: despite Saturn owning spec's
 *   "chores", the pre-existing "clean the house" entry already treated
 *   cleaning as a home/self-care activity (spec's Moon: "home ... rest,
 *   self-care"), and a bare "clean" fully subsumes that old phrase. Keeping
 *   it a single category (rather than also adding it to Saturn) avoids a
 *   same-text tie between two categories for the same word. "shower"/"bath"
 *   join it under Moon for the same home/self-care reasoning. (Reviewer
 *   noted spec's literal word "chores" is Saturn's, not Moon's -- true, but
 *   reconsidered and left as-is for the tie/consistency reasons above; this
 *   is a one-word heuristic pick either way, not a load-bearing distinction.)
 * - "cake"/"snack"/"restaurant"/"movie"/"concert" go under Venus's
 *   treats/socializing cluster (spec: "socializing, treats"), not "eat"/
 *   "food"/"meal"/"dinner"/"lunch"/"breakfast": those broader, everyday meal
 *   words read as routine eating/cooking (Moon's "cook" already covers that
 *   domain) rather than a treat, and "eat" alone is too generic a verb to
 *   safely anchor a category without new false positives.
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
    "hike",
    "swim",
    "cardio",
    "tournament",
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
    "cake",
    "snack",
    "restaurant",
    "movie",
    "concert",
    "spa",
    "friend",
    // Reported gap: "Should I eat lamb"/"...eat a lamb" matched nothing at
    // all (no category had any eating/food keyword), so classifyVague's
    // "nothing matched" branch wrongly called it too vague. Added here, not
    // to Moon: Moon comes before Venus in TRANSIT_BODIES, and pickCategory
    // only replaces a leading match on a *strictly greater* count, so adding
    // "eat" to Moon would have turned "Should I eat some cake" (the
    // oracle-d4i regression test two lines below) into a 1-1 tie that Moon
    // wins by iteration order -- silently flipping that test's expected
    // Venus result. Putting it here instead makes that same phrase resolve
    // to Venus even more clearly (2 matches, not a tie).
    "eat",
    "meal",
    "food",
  ],
  Mercury: [
    "communicat",
    "writ",
    "email",
    "e-mail",
    "short trip",
    "commute",
    "tech",
    "code",
    "message",
    "report",
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
    "cruise",
    "seminar",
    "trivia",
    "wager",
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
    "bills",
    "grocer", // stems both "grocery" and "groceries" ("grocery" alone would not: -y vs -ies)
    "errand",
    "doctor",
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
    "clean",
    "shower",
    "bath",
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
    "audition",
    "recital",
    "public speaking",
  ],
} as const;

/**
 * Sensitivity-bucket keyword lists (oracle-2au), one per `SensitivityCategory`
 * except `violence_person`/`violence_object`/`none` (handled separately
 * below by `classifyViolence`, since those need verb+target reasoning, not
 * a flat keyword list) -- transcribed from the old flat CONSEQUENTIAL_KEYWORDS
 * list (oracle-cne/oracle-d4i), split by which real-life-decision category
 * each keyword names.
 *
 * "illegal" is listed as its own entry (not left to substring-match inside
 * "legal") because `keywordRegex` below requires a *leading* word boundary:
 * "illegal" no longer matches via "legal" embedded mid-word, so it needs an
 * explicit entry to keep being recognized.
 *
 * oracle-d4i (reviewer-flagged, still true post-oracle-2au): `category` and
 * the sensitivity keyword lists are independent Call 1 signals over the
 * same text -- adding a keyword to `CATEGORY_KEYWORDS` never makes it
 * sensitive too, and vice versa. Adding "doctor" to Saturn's list (chores: a
 * doctor's visit) without also adding it to `HEALTH_KEYWORDS` meant "Should
 * I go to the doctor for my checkup" would confidently classify as Saturn
 * *and* score "none" on sensitivity, sailing straight through to a verdict
 * instead of getting a disclaimer -- exactly the health-decision miss this
 * list exists to prevent. "doctor", "physician", and "checkup" are included
 * for that reason (not "appointment": too generic -- it also covers
 * non-health meetings/dates). Every other oracle-d4i keyword was rechecked
 * for the same gap and judged not to need an entry here: Saturn's "bills"
 * reads as routine chore/administrative text ("pay the bills") rather than
 * the spec's money examples (investment, loan, mortgage, savings, debt --
 * larger, one-off financial decisions), so it stays out; Jupiter's "wager"
 * is recreational, not the kind of money decision spec's examples describe.
 */
const HEALTH_KEYWORDS: readonly string[] = ["health", "medicat", "medicine", "surgery", "diagnos", "doctor", "physician", "checkup"];
const MONEY_KEYWORDS: readonly string[] = ["money", "invest", "loan", "mortgage", "savings", "debt"];
const LEGAL_KEYWORDS: readonly string[] = ["legal", "illegal", "lawsuit", "lawyer", "sue"];
const SAFETY_KEYWORDS: readonly string[] = ["safety", "dangerous", "unsafe"];
const RELATIONSHIP_ENDING_KEYWORDS: readonly string[] = [
  "break up",
  "breakup",
  "divorce",
  "end our relationship",
  "end my relationship",
  "end the relationship",
];
const JOB_QUITTING_KEYWORDS: readonly string[] = [
  "quit my job",
  "quit her job",
  "quit his job",
  "quit their job",
  "quitting my job",
  "resign",
];

/**
 * Self-harm/suicide-adjacent phrasing (oracle-2au): checked directly (not
 * via the generic violence-verb-plus-target heuristic below) because some of
 * this phrasing ("end my life") names no explicit violence verb from
 * `VIOLENCE_VERB_KEYWORDS` at all. Any match here is `violence_person`,
 * unconditionally -- per spec, self-harm is never merely "health", and this
 * whole bucket is the single highest-priority check in `route`.
 *
 * This is necessarily a best-effort literal-phrase list, not a robust
 * self-harm detector: it will miss creative/indirect/misspelled phrasing and
 * is not a substitute for a real safety classifier. Per spec's framing
 * ("false alarms are cheap, misses aren't funny"), the bias throughout this
 * module is toward over-recusing on any ambiguity, not under-recusing.
 */
const SELF_HARM_KEYWORDS: readonly string[] = [
  "hurt myself",
  "hurting myself",
  "harm myself",
  "harming myself",
  "kill myself",
  "killing myself",
  "end my life",
  "ending my life",
  "suicide",
  "self-harm",
  "self harm",
];

/**
 * Violence/harm verbs (oracle-2au), transcribed verbatim from the issue's
 * instructions. Combined with a target (see `PERSON_TARGET_KEYWORDS`/
 * `OBJECT_TARGET_KEYWORDS` below) to distinguish `violence_person` from
 * `violence_object`.
 *
 * Known limitation: "break" is a very common, mostly non-violent word
 * ("take a break", "coffee break", "break the ice", "break the news").
 * `hasViolenceVerb` strips the specific "break up"/"breakup" phrase before
 * matching (that phrase is `RELATIONSHIP_ENDING_KEYWORDS`'s concern, not
 * violence), but does not attempt to exclude every other idiomatic use of
 * "break" -- an activity like "should I break the ice with my new
 * coworkers" will spuriously match the violence-verb check. Since no target
 * keyword (person or object) is named either, `classifyViolence`'s ambiguous-
 * target bias then defaults it to `violence_person`, i.e. a false-positive
 * recusal rather than a false-negative miss. That is the intentional,
 * spec-directed trade-off ("false alarms are cheap, misses aren't funny"),
 * not an oversight -- but it is a real, known false-positive source worth
 * being aware of, not a claim that this heuristic is robust.
 */
const VIOLENCE_VERB_KEYWORDS: readonly string[] = ["hit", "hurt", "harm", "smash", "destroy", "break", "attack", "punch", "kill"];

/**
 * Person/animal violence targets (oracle-2au), transcribed verbatim from the
 * issue's instructions plus "somebody" as an obvious synonym of "someone".
 * "him"/"her"/"them" are in `WHOLE_WORD_KEYWORDS` below (see that set's own
 * comment) since as bare prefixes they collide constantly with unrelated
 * words ("here", "hero", "herself", "theme", "himself").
 */
const PERSON_TARGET_KEYWORDS: readonly string[] = [
  "person",
  "someone",
  "somebody",
  "myself",
  "him",
  "her",
  "them",
  "people",
  "friend",
  "family member",
  "dog",
  "cat",
  "animal",
  "pet",
  "human",
];

/**
 * Inanimate-object violence targets (oracle-2au), transcribed verbatim from
 * the issue's instructions ("printer, wall, phone, computer, furniture,
 * plate, things generically") plus the singular "thing" (matches "things"
 * too via the shared leading-boundary/no-trailing-boundary stemming, and
 * does not collide with "something"/"anything"/"nothing"/"everything": none
 * of those have a word boundary immediately before "thing").
 */
const OBJECT_TARGET_KEYWORDS: readonly string[] = ["printer", "wall", "phone", "computer", "furniture", "plate", "thing"];

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
 *
 * oracle-d4i added three more of the `PREFIX_EXCLUDES` kind while broadening
 * `CATEGORY_KEYWORDS`' real-world coverage: "cardiology"/"cardiologist"
 * start with "cardio" (Mars' new exercise keyword) but are a medical
 * context, not a workout; "codeine" and "codependent" both start with
 * "code" (Mercury's new tech keyword) but are a medication and a
 * relationship dynamic, neither tech-related; "trivial" starts with
 * "trivia" (Jupiter's new games-of-chance/learning keyword) but is an
 * unrelated, very common adjective.
 *
 * oracle-2au added four more of the same kind for the new
 * `PERSON_TARGET_KEYWORDS`/`OBJECT_TARGET_KEYWORDS` violence-target lists:
 * "petition" starts with "pet"; "petty" also starts with "pet"; "category"/
 * "catalog"/"catch"/"catastrophe" all start with "cat"; "dogma" starts with
 * "dog". (`WHOLE_WORD_KEYWORDS` was judged a worse fit for these than for
 * "spa"/"rest": "pet"/"cat"/"dog" all have valuable stemmed forms worth
 * preserving -- "pets", "cats", "dogs" -- that a full word-boundary match
 * would also block.)
 */
const PREFIX_EXCLUDES: Readonly<Record<string, readonly string[]>> = {
  sign: ["ificant"], // "significant"
  text: ["ure", "ile"], // "texture", "textile"
  plan: ["e", "kton"], // "plane"/"planet"/"planer", "plankton"
  class: ["ic"], // "classic"/"classical"
  invest: ["igat"], // "investigate"/"investigation"
  cardio: ["log"], // "cardiology"/"cardiologist"
  code: ["ine", "pendent"], // "codeine", "codependent"
  trivia: ["l"], // "trivial"
  pet: ["ition", "ty"], // "petition", "petty"
  cat: ["egory", "alog", "ch", "astrophe"], // "category", "catalog", "catch", "catastrophe"
  dog: ["ma"], // "dogma"
};

/**
 * "spa"/"rest" (oracle-cne): common prefixes of several unrelated words
 * ("space"/"spare"/"spark...", "restaurant"/"restore"/"result"/"restrict")
 * with no valuable stemmed form worth preserving, so they require a full
 * word match instead of a prefix match.
 *
 * "him"/"her"/"them" (oracle-2au, `PERSON_TARGET_KEYWORDS`): as bare
 * leading-boundary prefixes these would constantly false-positive on
 * extremely common unrelated words -- "here", "hero", "herb", "heritage",
 * "herself" for "her"; "theme", "themselves", "thematic" for "them" -- so
 * they require a full word match too. (This does mean "hurt herself"/"hurt
 * themselves" do not match via "her"/"them" specifically, but those read as
 * self-harm-on-someone-else's-behalf phrasing that `PERSON_TARGET_KEYWORDS`'
 * other entries, or the ambiguous-target bias in `classifyViolence`, still
 * catch.)
 */
const WHOLE_WORD_KEYWORDS: ReadonlySet<string> = new Set(["spa", "rest", "him", "her", "them"]);

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

function matchesAny(lowerText: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => keywordRegex(keyword).test(lowerText));
}

/**
 * Whether any `VIOLENCE_VERB_KEYWORDS` verb is present. Strips the specific
 * "break up"/"breakup" phrase first (see `VIOLENCE_VERB_KEYWORDS`'s comment):
 * that phrase is `RELATIONSHIP_ENDING_KEYWORDS`'s concern, not violence, and
 * without stripping it "should I break up with my partner" would spuriously
 * trigger the generic "break" verb match with no named target, defaulting
 * (via `classifyViolence`'s ambiguous-target bias) to `violence_person`
 * instead of the correct `relationship_ending`.
 */
function hasViolenceVerb(lowerText: string): boolean {
  const withoutBreakup = lowerText.replace(/\bbreak\s*-?\s*up\b/g, "");
  return matchesAny(withoutBreakup, VIOLENCE_VERB_KEYWORDS);
}

/**
 * Classifies violence/harm language into `violence_person`, `violence_object`,
 * or `undefined` (no violence detected at all), per oracle-2au's heuristic:
 * 1. Any `SELF_HARM_KEYWORDS` phrase -> `violence_person`, unconditionally.
 * 2. No violence verb present -> `undefined` (not a violence case).
 * 3. A violence verb plus a clear inanimate-object target and NO person/
 *    animal target -> `violence_object`.
 * 4. Otherwise (a person/animal target is named, or no target is named at
 *    all) -> `violence_person`. This is the deliberate "bias toward
 *    violence_person when ambiguous" the issue calls for: an unnamed or
 *    unrecognized target defaults to the safe (recusing) bucket rather than
 *    `violence_object`/`none`.
 *
 * Best-effort heuristic, not a robust classifier -- see `VIOLENCE_VERB_KEYWORDS`'s
 * comment for a known false-positive source ("break"'s many non-violent
 * idioms), and note this has no defense against adversarial phrasing that
 * avoids every listed verb/target word entirely (a real limitation of any
 * fixed keyword list).
 */
function classifyViolence(lowerText: string): "violence_person" | "violence_object" | undefined {
  if (matchesAny(lowerText, SELF_HARM_KEYWORDS)) {
    return "violence_person";
  }
  if (!hasViolenceVerb(lowerText)) {
    return undefined;
  }
  const hasPersonTarget = matchesAny(lowerText, PERSON_TARGET_KEYWORDS);
  const hasObjectTarget = matchesAny(lowerText, OBJECT_TARGET_KEYWORDS);
  if (hasObjectTarget && !hasPersonTarget) {
    return "violence_object";
  }
  return "violence_person";
}

/**
 * Classifies the activity's `SensitivityCategory` (oracle-2au), checked in
 * the same priority order `route` uses for recusal (violence_person > safety
 * > legal), then the disclaimer buckets (health/money/relationship_ending/
 * job_quitting -- checked in that order, but since all four carry the same
 * `disclaimer: true` behavior, their relative order among each other has no
 * routing consequence), then `violence_object`, then `none`. Placing
 * `violence_object` after the disclaimer buckets (rather than checking it
 * right alongside `violence_person`) is deliberate: per spec, only
 * `violence_person` gets veto power over everything else -- an activity that
 * reads as both e.g. "money" and "violence_object" (unlikely in practice, but
 * not impossible for a keyword-based heuristic) should still get the
 * `money` disclaimer treatment, not fall through to ordinary/no-disclaimer
 * handling.
 */
function classifySensitivity(lowerText: string): SensitivityCategory {
  const violence = classifyViolence(lowerText);
  if (violence === "violence_person") {
    return "violence_person";
  }
  if (matchesAny(lowerText, SAFETY_KEYWORDS)) return "safety";
  if (matchesAny(lowerText, LEGAL_KEYWORDS)) return "legal";
  if (matchesAny(lowerText, HEALTH_KEYWORDS)) return "health";
  if (matchesAny(lowerText, MONEY_KEYWORDS)) return "money";
  if (matchesAny(lowerText, RELATIONSHIP_ENDING_KEYWORDS)) return "relationship_ending";
  if (matchesAny(lowerText, JOB_QUITTING_KEYWORDS)) return "job_quitting";
  if (violence === "violence_object") return "violence_object";
  return "none";
}

/**
 * Deterministic "is this too vague?" probability: high when the text is very
 * short (<= 2 words), or when nothing recognizable matched at all -- no
 * category keyword AND `sensitivity === "none"`; low otherwise. Jittered the
 * same way as the rest of this module's Nouls (see `hashToUnitInterval`).
 *
 * The `sensitivity === "none"` clause (oracle-2au): a text that cleanly
 * matched a sensitivity bucket ("Should I take out a mortgage on a new
 * house") is self-evidently a specific, real question -- the stub's narrow
 * category keyword lists simply don't cover it, so keying vagueness off
 * `categoryMatched` alone would re-create the oracle-d4i bug class (keyword-
 * list gaps silently becoming false "too vague" needs-detail outcomes) for
 * exactly the disclaimer-bucket questions that must proceed to a verdict
 * per spec. A matched sensitivity bucket is therefore also treated as
 * evidence of specificity. This cannot undermine safety: the recusal buckets
 * (violence_person/safety/legal) are checked in `route` BEFORE vague, so a
 * recusing text never reaches the vague check regardless of what this
 * function returns (a one-word "suicide" similarly recuses before the
 * wordCount override can matter).
 *
 * The <= 2-word override deliberately stays independent of sensitivity: a
 * bare one-word text like "money" should still be asked to clarify rather
 * than confidently answered.
 */
function classifyVague(lowerText: string, categoryMatched: boolean, sensitivity: SensitivityCategory): Noul {
  const wordCount = lowerText.split(/\s+/).filter((word) => word.length > 0).length;
  const jitter = hashToUnitInterval(`${lowerText}|vague-jitter`) * 0.15;
  if (wordCount <= 2) {
    return clamp01(0.75 + jitter);
  }
  if (!categoryMatched && sensitivity === "none") {
    return clamp01(0.75 + jitter);
  }
  return clamp01(0.1 + jitter);
}

/** Call 1's stub implementation: pure function of the activity text alone. */
function stubClassify(activityText: string): ClassificationResult {
  const lowerText = activityText.trim().toLowerCase();
  const { body: category, matched } = pickCategory(lowerText);
  const sensitivity = classifySensitivity(lowerText);
  return {
    category,
    sensitivity,
    vague: classifyVague(lowerText, matched, sensitivity),
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
 * `ORACLE_KIND`/`parseOracleKind`). `"jev"` constructs the real `JevOracle`
 * (oracle-rwy, src/oracle-jev.ts), pointed at the deployed Worker named by
 * `VITE_WORKER_URL` (src/config.ts's `WORKER_URL`) -- required for "jev"
 * since there is no sensible default Worker URL to fall back to, but never
 * read at all for "stub" (the default), so an app running with the stub
 * oracle never needs it set.
 */
export function createOracle(kind: OracleKind): Oracle {
  switch (kind) {
    case "stub":
      return new StubOracle();
    case "jev":
      if (WORKER_URL === undefined) {
        throw new Error(
          "VITE_ORACLE=jev requires VITE_WORKER_URL to be set to the deployed Cloudflare Worker's URL.",
        );
      }
      return new JevOracle({ workerUrl: WORKER_URL });
  }
}
