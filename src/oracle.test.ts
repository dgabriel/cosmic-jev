import { describe, expect, it } from "vitest";
import {
  askOracle,
  CONSEQUENTIAL_THRESHOLD,
  createOracle,
  route,
  StubOracle,
  VAGUE_THRESHOLD,
  type ClassificationResult,
  type OracleContext,
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
  function classification(consequential: number, vague: number): ClassificationResult {
    return { category: "Mars", consequential, vague };
  }

  it("recuses just below, at, and just above the consequential threshold", () => {
    expect(route(classification(CONSEQUENTIAL_THRESHOLD - 0.01, 0)).kind).toBe("proceed");
    expect(route(classification(CONSEQUENTIAL_THRESHOLD, 0)).kind).toBe("recusal");
    expect(route(classification(CONSEQUENTIAL_THRESHOLD + 0.01, 0)).kind).toBe("recusal");
  });

  it("asks for detail just below, at, and just above the vague threshold (consequential low)", () => {
    expect(route(classification(0, VAGUE_THRESHOLD - 0.01)).kind).toBe("proceed");
    expect(route(classification(0, VAGUE_THRESHOLD)).kind).toBe("needs-detail");
    expect(route(classification(0, VAGUE_THRESHOLD + 0.01)).kind).toBe("needs-detail");
  });

  it("recuses even when vague is also high (consequential takes priority)", () => {
    const decision = route(classification(CONSEQUENTIAL_THRESHOLD, VAGUE_THRESHOLD));
    expect(decision.kind).toBe("recusal");
  });

  it("proceeds with the classified category when neither threshold is met", () => {
    const decision = route(classification(0, 0));
    expect(decision).toEqual({ kind: "proceed", category: "Mars" });
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

  it('does not score "pursue a hobby today" as consequential via "sue" inside "pursue"', async () => {
    const result = await oracle.classify("Should I pursue a hobby today");
    expect(result.consequential).toBeLessThan(CONSEQUENTIAL_THRESHOLD);
  });

  it('does not score "resolve an issue with a friend" as consequential via "sue" inside "issue"', async () => {
    const result = await oracle.classify("Resolve an issue with a friend");
    expect(result.consequential).toBeLessThan(CONSEQUENTIAL_THRESHOLD);
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

  it('is still consequential for "sued" (prefix stemming preserved for "sue")', async () => {
    const result = await oracle.classify("My landlord sued me over the lease");
    expect(result.consequential).toBeGreaterThanOrEqual(CONSEQUENTIAL_THRESHOLD);
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

  it('still scores "illegal" as consequential (added explicitly since "legal" no longer substring-matches it)', async () => {
    const result = await oracle.classify("Is it illegal to do this activity");
    expect(result.consequential).toBeGreaterThanOrEqual(CONSEQUENTIAL_THRESHOLD);
  });
});

describe("StubOracle recusal/needs-detail outcomes carry no verdict fields", () => {
  it("recuses on a consequential activity and the type has no favor/intensity to access", async () => {
    const oracle = new StubOracle();
    const context: OracleContext = {
      transits: makeTransitChart(),
      natal: makeNatalChart(),
      activityText: "Should I quit my job and take out a big loan for surgery",
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

  it("proceeds to a verdict for an ordinary, non-vague, non-consequential activity", async () => {
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
    }
  });
});

describe("createOracle", () => {
  it("returns a StubOracle for 'stub'", () => {
    expect(createOracle("stub")).toBeInstanceOf(StubOracle);
  });

  it("throws a clear not-yet-implemented error for 'jev'", () => {
    expect(() => createOracle("jev")).toThrow(/not yet implemented/i);
  });
});
