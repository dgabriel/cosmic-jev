import { describe, expect, it } from "vitest";
import {
  askOracle,
  createOracle,
  route,
  StubOracle,
  VAGUE_THRESHOLD,
  type ClassificationResult,
  type OracleContext,
  type SensitivityCategory,
  type VerdictInput,
} from "./oracle";
import { signForLongitude, TRANSIT_BODIES, type BodyPosition, type TransitBodyName, type TransitChart } from "./sky";
import type { NatalBodyPosition, NatalChart } from "./natal";

// NOTE: like sky.test.ts/aspects.test.ts, these tests cover structural and
// routing behavior only, using synthetic charts. They do not depend on any
// real ephemeris value.

/** Builds a synthetic BodyPosition at an arbitrary longitude. */
function makeBodyPosition(body: TransitBodyName, longitude: number, retrograde = false): BodyPosition {
  const { sign, degreeInSign } = signForLongitude(longitude);
  return { body, longitude, sign, degreeInSign, retrograde };
}

function makeNatalBodyPosition(body: TransitBodyName, longitude: number): NatalBodyPosition {
  return { ...makeBodyPosition(body, longitude), ambiguous: false };
}

function makeTransitChart(overrides: Partial<Record<TransitBodyName, BodyPosition>> = {}): TransitChart {
  const bodies = Object.fromEntries(
    TRANSIT_BODIES.map((body) => [body, overrides[body] ?? makeBodyPosition(body, 10 + 13 * TRANSIT_BODIES.indexOf(body))]),
  ) as TransitChart["bodies"];
  return { date: new Date("2024-06-01T00:00:00Z"), bodies, moonPhaseAngle: 0, moonPhase: "new" };
}

function makeNatalChart(): NatalChart {
  const bodies = Object.fromEntries(
    TRANSIT_BODIES.map((body) => [body, makeNatalBodyPosition(body, 50 + 17 * TRANSIT_BODIES.indexOf(body))]),
  ) as NatalChart["bodies"];
  return {
    input: { date: { year: 1990, month: 1, day: 1 } },
    instant: new Date("1990-01-01T12:00:00Z"),
    timeKnown: false,
    bodies,
    ascendant: { status: "not-computed" },
  };
}

describe("route", () => {
  function classification(sensitivity: SensitivityCategory, vague: number): ClassificationResult {
    return { category: "Mars", sensitivity, vague };
  }

  const RECUSING_SENSITIVITIES: readonly SensitivityCategory[] = ["violence_person", "safety", "legal"];
  const DISCLAIMER_SENSITIVITIES: readonly SensitivityCategory[] = ["health", "money", "relationship_ending", "job_quitting"];
  const NO_DISCLAIMER_SENSITIVITIES: readonly SensitivityCategory[] = ["violence_object", "none"];

  it.each(RECUSING_SENSITIVITIES)("recuses for sensitivity=%s regardless of vague", (sensitivity) => {
    expect(route(classification(sensitivity, 0)).kind).toBe("recusal");
    expect(route(classification(sensitivity, 1)).kind).toBe("recusal");
  });

  it.each(RECUSING_SENSITIVITIES)("route()'s recusal carries reason=%s for tests/telemetry", (sensitivity) => {
    const decision = route(classification(sensitivity, 0));
    expect(decision).toEqual({ kind: "recusal", reason: sensitivity });
  });

  it("checks violence_person with the highest priority: it wins even when safety/legal/health/money also apply"
    + " (adversarial-priority regression: sensitivity is a single classified bucket, so this exercises route()'s"
    + " own priority order directly rather than relying on StubOracle's heuristic to have picked one bucket)", () => {
    // route() only ever sees one sensitivity value at a time (Call 1's Choice
    // answer picks a single bucket) -- this test's point is that route()
    // itself, given that bucket is violence_person, never lets vague or any
    // other consideration turn it into anything but a recusal.
    expect(route(classification("violence_person", VAGUE_THRESHOLD)).kind).toBe("recusal");
    expect(route(classification("violence_person", 1)).kind).toBe("recusal");
  });

  it.each(DISCLAIMER_SENSITIVITIES)("proceeds with disclaimer=true for sensitivity=%s", (sensitivity) => {
    const decision = route(classification(sensitivity, 0));
    expect(decision).toEqual({ kind: "proceed", category: "Mars", disclaimer: true });
  });

  it.each(NO_DISCLAIMER_SENSITIVITIES)("proceeds with disclaimer=false for sensitivity=%s", (sensitivity) => {
    const decision = route(classification(sensitivity, 0));
    expect(decision).toEqual({ kind: "proceed", category: "Mars", disclaimer: false });
  });

  it("asks for detail just below, at, and just above the vague threshold (non-recusing sensitivity)", () => {
    expect(route(classification("none", VAGUE_THRESHOLD - 0.01)).kind).toBe("proceed");
    expect(route(classification("none", VAGUE_THRESHOLD)).kind).toBe("needs-detail");
    expect(route(classification("none", VAGUE_THRESHOLD + 0.01)).kind).toBe("needs-detail");
  });

  it("recuses even when vague is also high (violence_person/safety/legal take priority over vague)", () => {
    const decision = route(classification("safety", VAGUE_THRESHOLD));
    expect(decision.kind).toBe("recusal");
  });

  it("proceeds with the classified category and disclaimer=false when sensitivity is none and not vague", () => {
    const decision = route(classification("none", 0));
    expect(decision).toEqual({ kind: "proceed", category: "Mars", disclaimer: false });
  });
});

describe("StubOracle determinism", () => {
  it("classify() returns identical output for the same activity text", async () => {
    const oracle = new StubOracle();
    const first = await oracle.classify("Going for a run before work");
    const second = await oracle.classify("Going for a run before work");
    expect(second).toEqual(first);
  });

  it("verdict() returns identical output for the same VerdictInput", async () => {
    const oracle = new StubOracle();
    const input: VerdictInput = {
      category: "Mars",
      rulingBodyTransit: makeBodyPosition("Mars", 42, true),
      aspects: [{ transit: "Mars", natal: "Sun", aspect: "trine", orb: 1, applying: true }],
      moonPhase: "full",
      activityText: "Going for a run before work",
    };
    const first = await oracle.verdict(input);
    const second = await oracle.verdict({ ...input, aspects: [...input.aspects] });
    expect(second).toEqual(first);
  });

  it("askOracle() returns identical output for the same context, end to end", async () => {
    const oracle = new StubOracle();
    const context: OracleContext = {
      transits: makeTransitChart(),
      natal: makeNatalChart(),
      activityText: "Write a few emails and reply to texts",
    };
    const first = await askOracle(oracle, context);
    const second = await askOracle(oracle, {
      transits: makeTransitChart(),
      natal: makeNatalChart(),
      activityText: "Write a few emails and reply to texts",
    });
    expect(second).toEqual(first);
  });

  it("different activity text can change the classification (not a constant stub)", async () => {
    const oracle = new StubOracle();
    const run = await oracle.classify("Going for a run before work");
    const cook = await oracle.classify("Cooking dinner and relaxing at home");
    expect(run.category).toBe("Mars");
    expect(cook.category).toBe("Moon");
  });
});

describe("StubOracle category classification sanity", () => {
  const oracle = new StubOracle();

  const cases: Array<[string, TransitBodyName]> = [
    ["Going for a run and then a competitive workout", "Mars"],
    ["A romantic date night with beauty treatments", "Venus"],
    ["Writing emails and signing a short contract", "Mercury"],
    ["Taking a class to learn something before a long trip abroad", "Jupiter"],
    ["Finishing chores and long-term budget planning for work", "Saturn"],
    ["Cooking dinner and resting at home with family", "Moon"],
    ["A performance in the spotlight, center of attention on stage", "Sun"],
  ];

  it.each(cases)("classifies %j as ruled by %s", async (text, expected) => {
    const result = await oracle.classify(text);
    expect(result.category).toBe(expected);
  });
});

// Regression tests for reviewer-found keyword-matching bugs: plain substring
// `.includes()` let short keywords match embedded inside unrelated words.
// `keywordRegex` (word-boundary matching) fixes the mid-word cases directly;
// `PREFIX_EXCLUDES`/`WHOLE_WORD_KEYWORDS` fix the rarer word-initial cases
// found while rechecking the lists for the same bug class.
describe("StubOracle keyword-matching false positives (mid-word substring collisions)", () => {
  const oracle = new StubOracle();

  it('does not score "pursue a hobby today" as legal via "sue" inside "pursue"', async () => {
    const result = await oracle.classify("Should I pursue a hobby today");
    expect(result.sensitivity).not.toBe("legal");
  });

  it('does not score "resolve an issue with a friend" as legal via "sue" inside "issue"', async () => {
    const result = await oracle.classify("Resolve an issue with a friend");
    expect(result.sensitivity).not.toBe("legal");
  });

  it('does not classify a plain "brunch" activity as Mars via "run" inside "brunch"', async () => {
    // Isolated on purpose: this sentence has no other substring match in any
    // category list (verified against the exact keyword lists), so the only
    // signal at all, pre-fix, was the spurious "run" inside "brunch".
    // Pre-fix (plain `.includes()`), that alone made this classify as Mars,
    // matched=true. Post-fix, "run" requires a leading word boundary that
    // "brunch" doesn't provide, so *nothing* matches: this must fall through
    // to the vague/needs-detail path, not confidently land on Mars (or any
    // other specific category, which the hash-derived fallback doesn't
    // promise and this test doesn't need to predict).
    const result = await oracle.classify("Just having brunch this morning");
    expect(result.category).not.toBe("Mars");
    expect(result.vague).toBeGreaterThanOrEqual(VAGUE_THRESHOLD);
  });

  it('does not classify a plain "design" activity as Mercury via "sign" inside "design"', async () => {
    // Isolated on purpose: no other keyword (in any category) substring-
    // matches this sentence (verified against the exact keyword lists), so
    // pre-fix the only signal was the spurious "sign" inside "design".
    // Pre-fix, that alone made this classify as Mercury, matched=true.
    // Post-fix, "sign" requires a leading word boundary "design" doesn't
    // provide, so nothing matches: this must fall through to the
    // vague/needs-detail path, not confidently land on Mercury.
    const result = await oracle.classify("Design a poster for the show");
    expect(result.category).not.toBe("Mercury");
    expect(result.vague).toBeGreaterThanOrEqual(VAGUE_THRESHOLD);
  });

  it('is still legal for "sued" (prefix stemming preserved for "sue")', async () => {
    const result = await oracle.classify("My landlord sued me over the lease");
    expect(result.sensitivity).toBe("legal");
  });
});

describe("StubOracle keyword-matching false positives (word-initial prefix collisions)", () => {
  const oracle = new StubOracle();

  it('classifies as Jupiter via "celebrat", not Mercury via "sign" inside "significant"', async () => {
    const result = await oracle.classify("A significant milestone celebration");
    expect(result.category).toBe("Jupiter");
  });

  it('classifies as Venus via "romantic", not Moon via "rest" inside "restaurant"', async () => {
    const result = await oracle.classify("A romantic dinner at a nice restaurant");
    expect(result.category).toBe("Venus");
  });

  it('still scores "illegal" as legal (added explicitly since "legal" no longer substring-matches it)', async () => {
    const result = await oracle.classify("Is it illegal to do this activity");
    expect(result.sensitivity).toBe("legal");
  });
});

describe("StubOracle recusal/needs-detail outcomes carry no verdict fields", () => {
  it("recuses on a safety activity and the type has no favor/intensity to access", async () => {
    const oracle = new StubOracle();
    const context: OracleContext = {
      transits: makeTransitChart(),
      natal: makeNatalChart(),
      activityText: "Should I walk home alone in this dangerous, unsafe neighborhood",
    };
    const outcome = await askOracle(oracle, context);
    expect(outcome.kind).toBe("recusal");
    // Runtime check: the recusal branch is a bare `{ kind: "recusal" }`.
    expect(Object.keys(outcome)).toEqual(["kind"]);
    if (outcome.kind === "recusal") {
      // Compile-time check: TypeScript must reject accessing verdict-only
      // fields on the narrowed recusal type. If this ever stops erroring
      // (e.g. because the union was widened), `tsc --noEmit` will fail on
      // the missing `@ts-expect-error`, catching the regression.
      // @ts-expect-error -- "favor" does not exist on the recusal outcome
      expect(outcome.favor).toBeUndefined();
    }
  });

  it("asks for more detail on a too-vague activity and the type has no favor/intensity to access", async () => {
    const oracle = new StubOracle();
    const context: OracleContext = {
      transits: makeTransitChart(),
      natal: makeNatalChart(),
      activityText: "it",
    };
    const outcome = await askOracle(oracle, context);
    expect(outcome.kind).toBe("needs-detail");
    expect(Object.keys(outcome)).toEqual(["kind"]);
    if (outcome.kind === "needs-detail") {
      // @ts-expect-error -- "favor" does not exist on the needs-detail outcome
      expect(outcome.favor).toBeUndefined();
    }
  });

  it("proceeds to a verdict for an ordinary, non-vague, non-sensitive activity, with disclaimer=false", async () => {
    const oracle = new StubOracle();
    const context: OracleContext = {
      transits: makeTransitChart(),
      natal: makeNatalChart(),
      activityText: "Going for a run before work",
    };
    const outcome = await askOracle(oracle, context);
    expect(outcome.kind).toBe("verdict");
    if (outcome.kind === "verdict") {
      expect(outcome.category).toBe("Mars");
      expect(outcome.favor).toBeGreaterThanOrEqual(0);
      expect(outcome.favor).toBeLessThanOrEqual(1);
      expect(outcome.intensity).toBeGreaterThanOrEqual(0);
      expect(outcome.intensity).toBeLessThanOrEqual(1);
      expect(outcome.rulingBodyTransit.body).toBe("Mars");
      expect(Array.isArray(outcome.aspects)).toBe(true);
      expect(outcome.moonPhase).toBe(context.transits.moonPhase);
      expect(outcome.disclaimer).toBe(false);
    }
  });

  it("proceeds to a verdict with disclaimer=true for a health/money/relationship/job-quitting activity (oracle-2au: these no longer recuse)", async () => {
    const oracle = new StubOracle();
    const context: OracleContext = {
      transits: makeTransitChart(),
      natal: makeNatalChart(),
      activityText: "Should I go to the doctor for my checkup",
    };
    const outcome = await askOracle(oracle, context);
    expect(outcome.kind).toBe("verdict");
    if (outcome.kind === "verdict") {
      expect(outcome.disclaimer).toBe(true);
    }
  });
});

// Regression tests for oracle-d4i: activities with no keyword match at all
// were misrouted to the vague/needs-detail path, even when clearly
// categorizable in everyday phrasing. `classifyVague` returns a high
// probability whenever `categoryMatched` is false, so any gap in
// CATEGORY_KEYWORDS silently became a false "too vague" recusal.
describe("StubOracle vague-path false positives (missing everyday-phrasing keywords)", () => {
  const oracle = new StubOracle();

  it('does not classify "Should I clean my bathroom" as vague (standalone "clean" under Moon)', async () => {
    const result = await oracle.classify("Should I clean my bathroom");
    expect(result.vague).toBeLessThan(VAGUE_THRESHOLD);
    expect(result.category).toBe("Moon");
  });

  it('does not classify "Should I eat some cake" as vague ("cake" under Venus)', async () => {
    const result = await oracle.classify("Should I eat some cake");
    expect(result.vague).toBeLessThan(VAGUE_THRESHOLD);
    expect(result.category).toBe("Venus");
  });

  it('classifies "Take a long shower and a bath before bed" as Moon (self-care)', async () => {
    const result = await oracle.classify("Take a long shower and a bath before bed");
    expect(result.vague).toBeLessThan(VAGUE_THRESHOLD);
    expect(result.category).toBe("Moon");
  });

  it('classifies "Grab a snack at the new restaurant" as Venus (treats/socializing)', async () => {
    const result = await oracle.classify("Grab a snack at the new restaurant");
    expect(result.vague).toBeLessThan(VAGUE_THRESHOLD);
    expect(result.category).toBe("Venus");
  });

  it('classifies "Pay the bills and pick up groceries" as Saturn (chores)', async () => {
    const result = await oracle.classify("Pay the bills and pick up groceries");
    expect(result.vague).toBeLessThan(VAGUE_THRESHOLD);
    expect(result.category).toBe("Saturn");
  });

  it('classifies "Write some code and send a status report" as Mercury (tech/communication)', async () => {
    const result = await oracle.classify("Write some code and send a status report");
    expect(result.vague).toBeLessThan(VAGUE_THRESHOLD);
    expect(result.category).toBe("Mercury");
  });

  it('classifies "Book a cruise and go to a trivia night" as Jupiter (long travel/games of chance)', async () => {
    const result = await oracle.classify("Book a cruise and go to a trivia night");
    expect(result.vague).toBeLessThan(VAGUE_THRESHOLD);
    expect(result.category).toBe("Jupiter");
  });

  it('does not match "cardio" (Mars) inside "cardiologist" (no keyword from ANY list in this sentence, so it must fall through to vague)', async () => {
    // Post-oracle-2au, classifyVague also returns low on a SENSITIVITY
    // keyword match, not just a category match -- so the sentence here must
    // avoid both for the vague assertion to discriminate. That is why the
    // old "...for a checkup" phrasing moved to the next test: "checkup" is
    // a HEALTH_KEYWORDS entry and now pins vague LOW regardless, making the
    // vague assertion useless for this regression there. If "cardio" ever
    // substring-matches inside "cardiologist" again, Mars matches as a
    // category here and vague drops below the threshold, failing this test.
    const result = await oracle.classify("Seen my cardiologist");
    expect(result.vague).toBeGreaterThanOrEqual(VAGUE_THRESHOLD);
  });

  it('classifies "Went to see my cardiologist for a checkup" as health and NOT vague (a sensitivity match is a specific text, oracle-2au), proceeding to a disclaimer verdict end to end', async () => {
    const result = await oracle.classify("Went to see my cardiologist for a checkup");
    expect(result.sensitivity).toBe("health");
    expect(result.vague).toBeLessThan(VAGUE_THRESHOLD);
    const context: OracleContext = {
      transits: makeTransitChart(),
      natal: makeNatalChart(),
      activityText: "Went to see my cardiologist for a checkup",
    };
    const outcome = await askOracle(oracle, context);
    expect(outcome.kind).toBe("verdict");
    if (outcome.kind === "verdict") {
      expect(outcome.disclaimer).toBe(true);
    }
  });

  it('does not match "trivia" (Jupiter) inside "trivial" (no other keyword in this sentence, so it must fall through to vague)', async () => {
    const result = await oracle.classify("That is a trivial concern");
    expect(result.vague).toBeGreaterThanOrEqual(VAGUE_THRESHOLD);
  });

  it('classifies "Go for a hike this weekend" as Mars ("hike")', async () => {
    const result = await oracle.classify("Go for a hike this weekend");
    expect(result.vague).toBeLessThan(VAGUE_THRESHOLD);
    expect(result.category).toBe("Mars");
  });

  it('classifies "Swim some laps at the pool" as Mars ("swim")', async () => {
    const result = await oracle.classify("Swim some laps at the pool");
    expect(result.vague).toBeLessThan(VAGUE_THRESHOLD);
    expect(result.category).toBe("Mars");
  });

  it('classifies "Enter the local tournament" as Mars ("tournament")', async () => {
    const result = await oracle.classify("Enter the local tournament");
    expect(result.vague).toBeLessThan(VAGUE_THRESHOLD);
    expect(result.category).toBe("Mars");
  });

  it('classifies "Watch a movie tonight" as Venus ("movie")', async () => {
    const result = await oracle.classify("Watch a movie tonight");
    expect(result.vague).toBeLessThan(VAGUE_THRESHOLD);
    expect(result.category).toBe("Venus");
  });

  it('classifies "Go to a concert this weekend" as Venus ("concert")', async () => {
    const result = await oracle.classify("Go to a concert this weekend");
    expect(result.vague).toBeLessThan(VAGUE_THRESHOLD);
    expect(result.category).toBe("Venus");
  });

  it('classifies "Send a message to my team" as Mercury ("message")', async () => {
    const result = await oracle.classify("Send a message to my team");
    expect(result.vague).toBeLessThan(VAGUE_THRESHOLD);
    expect(result.category).toBe("Mercury");
  });

  it('classifies "Take a seminar this weekend" as Jupiter ("seminar")', async () => {
    const result = await oracle.classify("Take a seminar this weekend");
    expect(result.vague).toBeLessThan(VAGUE_THRESHOLD);
    expect(result.category).toBe("Jupiter");
  });

  it('classifies "Place a wager on the game" as Jupiter ("wager")', async () => {
    const result = await oracle.classify("Place a wager on the game");
    expect(result.vague).toBeLessThan(VAGUE_THRESHOLD);
    expect(result.category).toBe("Jupiter");
  });

  it('classifies "Do a few errands today" as Saturn ("errand")', async () => {
    const result = await oracle.classify("Do a few errands today");
    expect(result.vague).toBeLessThan(VAGUE_THRESHOLD);
    expect(result.category).toBe("Saturn");
  });

  it('classifies "Practice for my audition tonight" as Sun ("audition")', async () => {
    const result = await oracle.classify("Practice for my audition tonight");
    expect(result.vague).toBeLessThan(VAGUE_THRESHOLD);
    expect(result.category).toBe("Sun");
  });

  it('classifies "Attend a recital downtown" as Sun ("recital")', async () => {
    const result = await oracle.classify("Attend a recital downtown");
    expect(result.vague).toBeLessThan(VAGUE_THRESHOLD);
    expect(result.category).toBe("Sun");
  });

  it('classifies "Do some public speaking training" as Sun ("public speaking")', async () => {
    const result = await oracle.classify("Do some public speaking training");
    expect(result.vague).toBeLessThan(VAGUE_THRESHOLD);
    expect(result.category).toBe("Sun");
  });

  it('does not match "code" (Mercury) inside "codeine" (no other keyword in this sentence, so it must fall through to vague)', async () => {
    const result = await oracle.classify("I need to take some codeine for the pain");
    expect(result.vague).toBeGreaterThanOrEqual(VAGUE_THRESHOLD);
  });

  it('does not match "code" (Mercury) inside "codependent" (no other keyword in this sentence, so it must fall through to vague)', async () => {
    const result = await oracle.classify("We have a codependent relationship");
    expect(result.vague).toBeGreaterThanOrEqual(VAGUE_THRESHOLD);
  });
});

// Regression tests for the reviewer-flagged oracle-d4i gap (still relevant
// post-oracle-2au): `category` and `sensitivity` are independent Call 1
// signals over the same text, so adding "doctor" to Saturn's
// CATEGORY_KEYWORDS (a doctor's visit as a chore) did nothing on its own to
// flag a doctor's-visit activity as health-sensitive. "doctor"/"physician"/
// "checkup" are in `HEALTH_KEYWORDS` so `route()` still flags these with a
// disclaimer, regardless of which category they classify into. Per
// oracle-2au's new policy, health (non-self-harm) proceeds to a real verdict
// with `disclaimer: true` rather than recusing.
describe("StubOracle health-sensitivity coverage for doctor/health-adjacent activities", () => {
  const oracle = new StubOracle();

  it('scores "Should I go to the doctor for my checkup" as health ("doctor"/"checkup")', async () => {
    const result = await oracle.classify("Should I go to the doctor for my checkup");
    expect(result.sensitivity).toBe("health");
  });

  it('proceeds to a disclaimer-flagged verdict for "Should I go to the doctor for my checkup" end to end (does not recuse)', async () => {
    const context: OracleContext = {
      transits: makeTransitChart(),
      natal: makeNatalChart(),
      activityText: "Should I go to the doctor for my checkup",
    };
    const outcome = await askOracle(oracle, context);
    expect(outcome.kind).toBe("verdict");
    if (outcome.kind === "verdict") {
      expect(outcome.disclaimer).toBe(true);
    }
  });

  it('scores "See a physician about this" as health ("physician")', async () => {
    const result = await oracle.classify("See a physician about this");
    expect(result.sensitivity).toBe("health");
  });
});

// oracle-2au: StubOracle's real sensitivity-bucket heuristic. Each
// non-violence bucket's own keyword coverage first, then the
// violence_person/violence_object heuristic (self-harm, verb+target,
// ambiguous-target bias), then the adversarial-priority cases the issue
// specifically calls for.
describe("StubOracle sensitivity buckets: money/relationship_ending/job_quitting/safety/legal", () => {
  const oracle = new StubOracle();

  it('classifies "Should I take out a mortgage on a new house" as money', async () => {
    const result = await oracle.classify("Should I take out a mortgage on a new house");
    expect(result.sensitivity).toBe("money");
  });

  it('classifies "Should I get a divorce" as relationship_ending', async () => {
    const result = await oracle.classify("Should I get a divorce");
    expect(result.sensitivity).toBe("relationship_ending");
  });

  it('classifies "Should I resign from my position" as job_quitting', async () => {
    const result = await oracle.classify("Should I resign from my position");
    expect(result.sensitivity).toBe("job_quitting");
  });

  it('classifies "Is it dangerous and unsafe to go there" as safety', async () => {
    const result = await oracle.classify("Is it dangerous and unsafe to go there");
    expect(result.sensitivity).toBe("safety");
  });

  it('classifies "Should I sue my landlord" as legal', async () => {
    const result = await oracle.classify("Should I sue my landlord");
    expect(result.sensitivity).toBe("legal");
  });

  const DISCLAIMER_BUCKET_EXAMPLES: ReadonlyArray<[string, string]> = [
    ["money", "Should I take out a mortgage on a new house"],
    ["relationship_ending", "Should I get a divorce"],
    ["job_quitting", "Should I resign from my position"],
    ["health", "Should I go to the doctor for my checkup"],
  ];

  it.each(DISCLAIMER_BUCKET_EXAMPLES)("%s proceeds to a verdict with disclaimer=true end to end (never recuses)", async (_bucket, activityText) => {
    const context: OracleContext = { transits: makeTransitChart(), natal: makeNatalChart(), activityText };
    const outcome = await askOracle(oracle, context);
    expect(outcome.kind).toBe("verdict");
    if (outcome.kind === "verdict") {
      expect(outcome.disclaimer).toBe(true);
    }
  });
});

describe("StubOracle violence_person via self-harm phrasing (oracle-2au, highest priority)", () => {
  const oracle = new StubOracle();

  it.each([
    "Should I hurt myself",
    "Should I harm myself after this bad day",
    "I've been thinking about hurting myself",
    "Should I end my life",
    "I keep thinking about suicide",
  ])("classifies %j as violence_person", async (text) => {
    const result = await oracle.classify(text);
    expect(result.sensitivity).toBe("violence_person");
  });

  it("recuses end to end for self-harm phrasing, exactly like the release-gate's mild self-harm test row", async () => {
    const context: OracleContext = {
      transits: makeTransitChart(),
      natal: makeNatalChart(),
      activityText: "Should I hurt myself",
    };
    const outcome = await askOracle(oracle, context);
    expect(outcome.kind).toBe("recusal");
  });
});

describe("StubOracle violence_person vs violence_object (verb + target heuristic)", () => {
  const oracle = new StubOracle();

  it('classifies "Should I hit my brother" as violence_person (verb + person target)', async () => {
    const result = await oracle.classify("Should I hit my brother");
    // "brother" is not itself a listed target keyword, but with no
    // recognized object target present either, the ambiguous-target bias
    // still lands this on violence_person (see classifyViolence's doc
    // comment) -- this test doesn't depend on "brother" being listed.
    expect(result.sensitivity).toBe("violence_person");
  });

  it('classifies "Should I hurt my friend" as violence_person (verb + explicit person target)', async () => {
    const result = await oracle.classify("Should I hurt my friend");
    expect(result.sensitivity).toBe("violence_person");
  });

  it('classifies "Should I hurt my dog" as violence_person (verb + animal target)', async () => {
    const result = await oracle.classify("Should I hurt my dog");
    expect(result.sensitivity).toBe("violence_person");
  });

  it('classifies "Should I smash my printer with a baseball bat" as violence_object (verb + clear inanimate target, no person target)', async () => {
    const result = await oracle.classify("Should I smash my printer with a baseball bat");
    expect(result.sensitivity).toBe("violence_object");
  });

  it('classifies "Should I destroy my old computer" as violence_object', async () => {
    const result = await oracle.classify("Should I destroy my old computer");
    expect(result.sensitivity).toBe("violence_object");
  });

  it("violence_object proceeds to a verdict end to end: no recusal, disclaimer=false", async () => {
    const context: OracleContext = {
      transits: makeTransitChart(),
      natal: makeNatalChart(),
      activityText: "Should I smash my printer with a baseball bat",
    };
    const outcome = await askOracle(oracle, context);
    expect(outcome.kind).toBe("verdict");
    if (outcome.kind === "verdict") {
      expect(outcome.disclaimer).toBe(false);
    }
  });

  it('classifies "Should I punch someone at the party" as violence_person (verb + explicit person target, even with no self-harm phrasing)', async () => {
    const result = await oracle.classify("Should I punch someone at the party");
    expect(result.sensitivity).toBe("violence_person");
  });

  it('defaults an ambiguous target ("Should I hit something") to violence_person, not none/violence_object', async () => {
    // "something" contains no leading-word-boundary "thing" (see
    // OBJECT_TARGET_KEYWORDS's comment) and names no person/animal either --
    // this is exactly the "no clear target named" case the issue calls out,
    // which must default to violence_person, not silently fall through.
    const result = await oracle.classify("Should I hit something");
    expect(result.sensitivity).toBe("violence_person");
  });

  it('does not treat "Should I break up with my partner" as violence (the "break up" phrase is stripped before violence-verb matching)', async () => {
    const result = await oracle.classify("Should I break up with my partner");
    expect(result.sensitivity).toBe("relationship_ending");
  });
});

describe("StubOracle adversarial sensitivity priority: violence_person/safety must still recuse even when another bucket's keywords also match", () => {
  const oracle = new StubOracle();

  it('classifies text reading as BOTH violence_person AND health as violence_person (verb+person-target keywords win over "surgery")', async () => {
    // Contains "surgery" (HEALTH_KEYWORDS) and a violence verb + explicit
    // person target ("hurt"/"myself") in the same sentence.
    const result = await oracle.classify("Should I hurt myself instead of getting the surgery");
    expect(result.sensitivity).toBe("violence_person");
  });

  it("recuses end to end for that same both-violence_person-and-health text, not a health-disclaimer verdict", async () => {
    const context: OracleContext = {
      transits: makeTransitChart(),
      natal: makeNatalChart(),
      activityText: "Should I hurt myself instead of getting the surgery",
    };
    const outcome = await askOracle(oracle, context);
    expect(outcome.kind).toBe("recusal");
  });

  it('classifies text reading as BOTH safety AND money as safety ("dangerous" is checked before "invest")', async () => {
    const result = await oracle.classify("Is it dangerous to invest all my savings in this");
    expect(result.sensitivity).toBe("safety");
  });

  it("recuses end to end for that same both-safety-and-money text, not a money-disclaimer verdict", async () => {
    const context: OracleContext = {
      transits: makeTransitChart(),
      natal: makeNatalChart(),
      activityText: "Is it dangerous to invest all my savings in this",
    };
    const outcome = await askOracle(oracle, context);
    expect(outcome.kind).toBe("recusal");
  });
});

describe("createOracle", () => {
  it("returns a StubOracle for 'stub'", () => {
    expect(createOracle("stub")).toBeInstanceOf(StubOracle);
  });

  it("throws a clear configuration error for 'jev' when VITE_WORKER_URL is unset", () => {
    // src/config.ts's WORKER_URL is undefined in this test run (no
    // VITE_WORKER_URL configured), so this exercises createOracle's own
    // guard rather than JevOracle itself (covered in oracle-jev.test.ts).
    expect(() => createOracle("jev")).toThrow(/VITE_WORKER_URL/);
  });
});
