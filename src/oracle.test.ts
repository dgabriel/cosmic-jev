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
//
// StubOracle's classify() is a local, offline heuristic used only for dev/
// tests -- the deployed app always talks to the real Jev model instead (see
// oracle-jev.test.ts). So this file checks the shape of the heuristic
// (word-boundary matching, sensitivity priority, determinism) with a handful
// of representative cases, not an exhaustive per-keyword catalog: each
// individual keyword/phrase is not independently load-bearing the way a real
// ephemeris value or an API response shape is.

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

  it.each(RECUSING_SENSITIVITIES)("recuses for sensitivity=%s regardless of vague, with reason=%s", (sensitivity) => {
    expect(route(classification(sensitivity, 0))).toEqual({ kind: "recusal", reason: sensitivity });
    expect(route(classification(sensitivity, 1))).toEqual({ kind: "recusal", reason: sensitivity });
  });

  it("violence_person wins even when safety/legal/health/money also apply (adversarial priority)", () => {
    expect(route(classification("violence_person", VAGUE_THRESHOLD)).kind).toBe("recusal");
  });

  it.each(DISCLAIMER_SENSITIVITIES)("proceeds with disclaimer=true for sensitivity=%s", (sensitivity) => {
    expect(route(classification(sensitivity, 0))).toEqual({ kind: "proceed", category: "Mars", disclaimer: true });
  });

  it.each(NO_DISCLAIMER_SENSITIVITIES)("proceeds with disclaimer=false for sensitivity=%s", (sensitivity) => {
    expect(route(classification(sensitivity, 0))).toEqual({ kind: "proceed", category: "Mars", disclaimer: false });
  });

  it("asks for detail just below, at, and just above the vague threshold (non-recusing sensitivity)", () => {
    expect(route(classification("none", VAGUE_THRESHOLD - 0.01)).kind).toBe("proceed");
    expect(route(classification("none", VAGUE_THRESHOLD)).kind).toBe("needs-detail");
    expect(route(classification("none", VAGUE_THRESHOLD + 0.01)).kind).toBe("needs-detail");
  });

  it("recuses even when vague is also high (violence_person/safety/legal take priority over vague)", () => {
    expect(route(classification("safety", VAGUE_THRESHOLD)).kind).toBe("recusal");
  });
});

describe("StubOracle determinism", () => {
  it("classify()/verdict()/askOracle() all return identical output for identical input", async () => {
    const oracle = new StubOracle();
    const text = "Going for a run before work";
    expect(await oracle.classify(text)).toEqual(await oracle.classify(text));

    const input: VerdictInput = {
      category: "Mars",
      rulingBodyTransit: makeBodyPosition("Mars", 42, true),
      aspects: [{ transit: "Mars", natal: "Sun", aspect: "trine", orb: 1, applying: true }],
      moonPhase: "full",
      activityText: text,
    };
    expect(await oracle.verdict(input)).toEqual(await oracle.verdict({ ...input, aspects: [...input.aspects] }));

    const context: OracleContext = { transits: makeTransitChart(), natal: makeNatalChart(), activityText: text };
    expect(await askOracle(oracle, context)).toEqual(
      await askOracle(oracle, { transits: makeTransitChart(), natal: makeNatalChart(), activityText: text }),
    );
  });

  it("different activity text can change the classification (not a constant stub)", async () => {
    const oracle = new StubOracle();
    const run = await oracle.classify("Going for a run before work");
    const cook = await oracle.classify("Cooking dinner and relaxing at home");
    expect(run.category).toBe("Mars");
    expect(cook.category).toBe("Moon");
  });
});

describe("StubOracle category classification", () => {
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

// Regression coverage for reviewer-found keyword-matching bugs: plain
// substring `.includes()` let short keywords match embedded inside unrelated
// words ("sue" inside "pursue", "run" inside "brunch"). `keywordRegex`
// (word-boundary matching) fixes this; a couple of representative cases are
// enough to pin the behavior without re-testing every keyword.
describe("StubOracle keyword matching requires a word boundary (not substring)", () => {
  const oracle = new StubOracle();

  it('does not score "pursue a hobby today" as legal via "sue" inside "pursue"', async () => {
    const result = await oracle.classify("Should I pursue a hobby today");
    expect(result.sensitivity).not.toBe("legal");
  });

  it('falls through to vague for "Just having brunch this morning" (no real keyword match, "run" inside "brunch" must not count)', async () => {
    const result = await oracle.classify("Just having brunch this morning");
    expect(result.category).not.toBe("Mars");
    expect(result.vague).toBeGreaterThanOrEqual(VAGUE_THRESHOLD);
  });

  it('is still legal for "sued" (prefix stemming preserved for "sue")', async () => {
    const result = await oracle.classify("My landlord sued me over the lease");
    expect(result.sensitivity).toBe("legal");
  });

  it('still scores "illegal" as legal (explicit entry since "legal" no longer substring-matches it)', async () => {
    const result = await oracle.classify("Is it illegal to do this activity");
    expect(result.sensitivity).toBe("legal");
  });
});

describe("StubOracle recusal/needs-detail outcomes carry no verdict fields", () => {
  it("recuses on a safety activity, with a type that has no favor/intensity to access", async () => {
    const context: OracleContext = {
      transits: makeTransitChart(),
      natal: makeNatalChart(),
      activityText: "Should I walk home alone in this dangerous, unsafe neighborhood",
    };
    const outcome = await askOracle(new StubOracle(), context);
    expect(outcome.kind).toBe("recusal");
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

  it("proceeds to a verdict for an ordinary, non-vague, non-sensitive activity, with disclaimer=false", async () => {
    const context: OracleContext = {
      transits: makeTransitChart(),
      natal: makeNatalChart(),
      activityText: "Going for a run before work",
    };
    const outcome = await askOracle(new StubOracle(), context);
    expect(outcome.kind).toBe("verdict");
    if (outcome.kind === "verdict") {
      expect(outcome.category).toBe("Mars");
      expect(outcome.favor).toBeGreaterThanOrEqual(0);
      expect(outcome.favor).toBeLessThanOrEqual(1);
      expect(outcome.disclaimer).toBe(false);
    }
  });

  it("proceeds to a verdict with disclaimer=true for a health/money/relationship/job-quitting activity (oracle-2au: these no longer recuse)", async () => {
    const context: OracleContext = {
      transits: makeTransitChart(),
      natal: makeNatalChart(),
      activityText: "Should I go to the doctor for my checkup",
    };
    const outcome = await askOracle(new StubOracle(), context);
    expect(outcome.kind).toBe("verdict");
    if (outcome.kind === "verdict") {
      expect(outcome.disclaimer).toBe(true);
    }
  });
});

// Regression for oracle-d4i: activities with no keyword match at all were
// misrouted to the vague/needs-detail path even when clearly categorizable
// in everyday phrasing (classifyVague returns high whenever nothing
// matched). A few representative gap-fill cases, not the full keyword list.
describe("StubOracle does not misroute ordinary everyday phrasing to vague", () => {
  const oracle = new StubOracle();

  it.each([
    ["Should I clean my bathroom", "Moon"],
    ["Should I eat lamb", "Venus"],
    ["Pay the bills and pick up groceries", "Saturn"],
    ["Write some code and send a status report", "Mercury"],
  ] as const)("does not classify %j as vague", async (text, expectedCategory) => {
    const result = await oracle.classify(text);
    expect(result.vague).toBeLessThan(VAGUE_THRESHOLD);
    expect(result.category).toBe(expectedCategory);
  });

  it('does not match "cardio" (Mars) inside "cardiologist"; falls through to vague', async () => {
    const result = await oracle.classify("Seen my cardiologist");
    expect(result.vague).toBeGreaterThanOrEqual(VAGUE_THRESHOLD);
  });

  it('a sensitivity-only keyword match ("cardiologist"+"checkup" -> health) is not vague, and proceeds to a disclaimer verdict end to end', async () => {
    const result = await oracle.classify("Went to see my cardiologist for a checkup");
    expect(result.sensitivity).toBe("health");
    expect(result.vague).toBeLessThan(VAGUE_THRESHOLD);
    const outcome = await askOracle(oracle, {
      transits: makeTransitChart(),
      natal: makeNatalChart(),
      activityText: "Went to see my cardiologist for a checkup",
    });
    expect(outcome.kind).toBe("verdict");
    if (outcome.kind === "verdict") {
      expect(outcome.disclaimer).toBe(true);
    }
  });
});

describe("StubOracle sensitivity buckets", () => {
  const oracle = new StubOracle();

  it.each([
    ["Should I take out a mortgage on a new house", "money"],
    ["Should I get a divorce", "relationship_ending"],
    ["Should I resign from my position", "job_quitting"],
    ["Is it dangerous and unsafe to go there", "safety"],
    ["Should I sue my landlord", "legal"],
  ] as const)("classifies %j as %s", async (text, expected) => {
    const result = await oracle.classify(text);
    expect(result.sensitivity).toBe(expected);
  });

  it("a disclaimer bucket (money) proceeds to a verdict end to end, never recuses", async () => {
    const outcome = await askOracle(oracle, {
      transits: makeTransitChart(),
      natal: makeNatalChart(),
      activityText: "Should I take out a mortgage on a new house",
    });
    expect(outcome.kind).toBe("verdict");
    if (outcome.kind === "verdict") {
      expect(outcome.disclaimer).toBe(true);
    }
  });
});

describe("StubOracle violence_person vs violence_object (verb + target heuristic)", () => {
  const oracle = new StubOracle();

  it.each([
    "Should I hurt myself",
    "Should I end my life",
    "I keep thinking about suicide",
  ])("classifies self-harm phrasing %j as violence_person (highest priority, oracle-2au)", async (text) => {
    const result = await oracle.classify(text);
    expect(result.sensitivity).toBe("violence_person");
  });

  it('classifies "Should I hurt my friend" as violence_person (verb + person target)', async () => {
    const result = await oracle.classify("Should I hurt my friend");
    expect(result.sensitivity).toBe("violence_person");
  });

  it('classifies "Should I smash my printer with a baseball bat" as violence_object (verb + inanimate target, no person target)', async () => {
    const result = await oracle.classify("Should I smash my printer with a baseball bat");
    expect(result.sensitivity).toBe("violence_object");
  });

  it('defaults an ambiguous target ("Should I hit something") to violence_person, not none/violence_object', async () => {
    const result = await oracle.classify("Should I hit something");
    expect(result.sensitivity).toBe("violence_person");
  });

  it('does not treat "Should I break up with my partner" as violence ("break up" is stripped before violence-verb matching)', async () => {
    const result = await oracle.classify("Should I break up with my partner");
    expect(result.sensitivity).toBe("relationship_ending");
  });

  it("violence_object proceeds to a verdict end to end: no recusal, disclaimer=false", async () => {
    const outcome = await askOracle(oracle, {
      transits: makeTransitChart(),
      natal: makeNatalChart(),
      activityText: "Should I smash my printer with a baseball bat",
    });
    expect(outcome.kind).toBe("verdict");
    if (outcome.kind === "verdict") {
      expect(outcome.disclaimer).toBe(false);
    }
  });

  it("self-harm phrasing recuses end to end", async () => {
    const outcome = await askOracle(oracle, {
      transits: makeTransitChart(),
      natal: makeNatalChart(),
      activityText: "Should I hurt myself",
    });
    expect(outcome.kind).toBe("recusal");
  });
});

describe("StubOracle adversarial sensitivity priority", () => {
  const oracle = new StubOracle();

  it('picks violence_person over a co-occurring health keyword ("surgery"), and recuses end to end', async () => {
    const text = "Should I hurt myself instead of getting the surgery";
    const result = await oracle.classify(text);
    expect(result.sensitivity).toBe("violence_person");
    const outcome = await askOracle(oracle, { transits: makeTransitChart(), natal: makeNatalChart(), activityText: text });
    expect(outcome.kind).toBe("recusal");
  });

  it('picks safety over a co-occurring money keyword ("invest")', async () => {
    const result = await oracle.classify("Is it dangerous to invest all my savings in this");
    expect(result.sensitivity).toBe("safety");
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
