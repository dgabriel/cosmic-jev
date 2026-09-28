import { describe, expect, it } from "vitest";
import {
  CUSP_MESSAGE,
  DISCLAIMER_MESSAGE,
  emojiFor,
  explainAmbiguity,
  explainDisclaimer,
  explainOutcome,
  explainVerdict,
  FIRMNESS_DISTANCE_THRESHOLD,
  firmnessFor,
  MOON_CUSP_MESSAGE,
  NEEDS_DETAIL_MESSAGE,
  RECUSAL_MESSAGE,
} from "./explain";
import type { NatalBodyPosition, NatalChart } from "./natal";
import type { OracleOutcome } from "./oracle";
import { signForLongitude, TRANSIT_BODIES, type BodyPosition, type TransitBodyName } from "./sky";

function makeBodyPosition(body: TransitBodyName, longitude: number, retrograde = false): BodyPosition {
  const { sign, degreeInSign } = signForLongitude(longitude);
  return { body, longitude, sign, degreeInSign, retrograde };
}

function makeNatalBodyPosition(body: TransitBodyName, longitude: number, ambiguous = false): NatalBodyPosition {
  return { ...makeBodyPosition(body, longitude), ambiguous };
}

function makeNatalChart(overrides: Partial<NatalChart> = {}): NatalChart {
  const bodies = Object.fromEntries(
    TRANSIT_BODIES.map((body) => [body, makeNatalBodyPosition(body, 50 + 17 * TRANSIT_BODIES.indexOf(body))]),
  ) as NatalChart["bodies"];
  return {
    input: { date: { year: 1990, month: 1, day: 1 } },
    instant: new Date("1990-01-01T12:00:00Z"),
    timeKnown: false,
    bodies,
    ascendant: { status: "not-computed" },
    ...overrides,
  };
}

function makeVerdictOutcome(overrides: Partial<Extract<OracleOutcome, { kind: "verdict" }>> = {}): Extract<
  OracleOutcome,
  { kind: "verdict" }
> {
  return {
    kind: "verdict",
    category: "Mars",
    rulingBodyTransit: makeBodyPosition("Mars", 5, false), // Aries, direct
    aspects: [],
    moonPhase: "full",
    favor: 0.81,
    intensity: 0.5,
    disclaimer: false,
    ...overrides,
  };
}

describe("firmnessFor", () => {
  it("is Tentatively within the distance threshold of 0.5, Firmly beyond it", () => {
    expect(firmnessFor(0.5)).toBe("Tentatively");
    expect(firmnessFor(0.5 + FIRMNESS_DISTANCE_THRESHOLD - 0.01)).toBe("Tentatively");
    expect(firmnessFor(0.5 - FIRMNESS_DISTANCE_THRESHOLD + 0.01)).toBe("Tentatively");
    expect(firmnessFor(0.7)).toBe("Firmly");
    expect(firmnessFor(0.3)).toBe("Firmly");
  });
});

describe("emojiFor", () => {
  it("is a thumbs-up at and above 0.5, thumbs-down below it", () => {
    expect(emojiFor(0.5)).toBe("👍");
    expect(emojiFor(0.49)).toBe("👎");
  });
});

describe("explainOutcome: recusal and needs-detail", () => {
  it("renders the exact recusal wording and nothing numeric", () => {
    const message = explainOutcome({ kind: "recusal" }, "quit my job");
    expect(message).toBe(RECUSAL_MESSAGE);
    expect(message).toBe("The stars recommend therapy for this one.");
    expect(message).not.toMatch(/\d/);
  });

  it("renders a needs-detail message with no verdict or probability", () => {
    const message = explainOutcome({ kind: "needs-detail" }, "stuff");
    expect(message).toBe(NEEDS_DETAIL_MESSAGE);
    expect(message).not.toMatch(/\d/);
  });
});

describe("explainVerdict: the spec's own worked example", () => {
  it("matches docs/spec.md section 3's example sentence exactly", () => {
    const outcome = makeVerdictOutcome({
      aspects: [{ transit: "Mars", natal: "Sun", aspect: "trine", orb: 1, applying: true }],
    });
    const message = explainVerdict(outcome, "Bowling");
    expect(message).toBe(
      "Bowling is ruled by Mars. Mars is direct in Aries, trine your natal Sun. " +
        "The cosmos endorses this (p = 0.81).",
    );
  });
});

describe("explainVerdict: aspect list summary (0, 1, several)", () => {
  it("omits the aspect clause entirely when there are no aspects", () => {
    const outcome = makeVerdictOutcome({ aspects: [] });
    const message = explainVerdict(outcome, "bowling");
    expect(message).toContain("Mars is direct in Aries.");
    expect(message).not.toContain(",");
  });

  it("describes a single aspect", () => {
    const outcome = makeVerdictOutcome({
      aspects: [{ transit: "Mars", natal: "Sun", aspect: "square", orb: 1, applying: false }],
    });
    const message = explainVerdict(outcome, "bowling");
    expect(message).toContain("Mars is direct in Aries, square your natal Sun.");
  });

  it("joins several aspects with a trailing 'and'", () => {
    const outcome = makeVerdictOutcome({
      aspects: [
        { transit: "Mars", natal: "Sun", aspect: "trine", orb: 1, applying: true },
        { transit: "Mars", natal: "Moon", aspect: "sextile", orb: 0.5, applying: false },
      ],
    });
    const message = explainVerdict(outcome, "bowling");
    expect(message).toContain("Mars is direct in Aries, trine your natal Sun and sextile your natal Moon.");
  });
});

describe("explainVerdict: retrograde vs direct wording", () => {
  it("says 'direct' when the ruling body is not retrograde", () => {
    const outcome = makeVerdictOutcome({
      category: "Mercury",
      rulingBodyTransit: makeBodyPosition("Mercury", 100, false),
    });
    expect(explainVerdict(outcome, "writing emails")).toContain("Mercury is direct in");
  });

  it("says 'retrograde' when the ruling body is retrograde", () => {
    const outcome = makeVerdictOutcome({
      category: "Mercury",
      rulingBodyTransit: makeBodyPosition("Mercury", 100, true),
    });
    expect(explainVerdict(outcome, "writing emails")).toContain("Mercury is retrograde in");
  });
});

describe("explainVerdict: endorse vs skeptical wording", () => {
  it("endorses at/above 0.5 and is skeptical below it, with p= formatting, and never leaks firmness/emoji wording", () => {
    // Firmness/thumb-direction wording no longer appears in this sentence at
    // all (moved to src/experience/copy.ts, which reuses firmnessFor
    // directly and has its own quadrant tests).
    expect(explainVerdict(makeVerdictOutcome({ favor: 0.9 }), "bowling")).toBe(
      "Bowling is ruled by Mars. Mars is direct in Aries. The cosmos endorses this (p = 0.90).",
    );
    expect(explainVerdict(makeVerdictOutcome({ favor: 0.1 }), "bowling")).toContain(
      "The cosmos is skeptical of this (p = 0.10).",
    );
    expect(explainVerdict(makeVerdictOutcome({ favor: 0.55 }), "bowling")).toContain(
      "The cosmos endorses this (p = 0.55).",
    );
  });
});

describe("explainAmbiguity", () => {
  it("returns no messages for a fully unambiguous, time-known chart, nor for a merely not-computed Ascendant (no time/location given, expected)", () => {
    const natal = makeNatalChart({
      timeKnown: true,
      ascendant: { status: "ok", position: { longitude: 10, sign: "Aries", degreeInSign: 10 } },
    });
    expect(explainAmbiguity(natal)).toEqual([]);
    expect(explainAmbiguity(makeNatalChart({ ascendant: { status: "not-computed" } }))).toEqual([]);
  });

  it("flags the exact cusp wording when the natal Sun is ambiguous", () => {
    const natal = makeNatalChart();
    natal.bodies.Sun = makeNatalBodyPosition("Sun", 0, true);
    expect(explainAmbiguity(natal)).toContain(CUSP_MESSAGE);
    expect(explainAmbiguity(natal)).toContain("Born on a cusp. Add a birth time to settle it.");
  });

  it("flags the Moon-cusp wording when only the natal Moon is ambiguous", () => {
    const natal = makeNatalChart();
    natal.bodies.Moon = makeNatalBodyPosition("Moon", 0, true);
    const messages = explainAmbiguity(natal);
    expect(messages).toContain(MOON_CUSP_MESSAGE);
    expect(messages).not.toContain(CUSP_MESSAGE);
  });

  it("flags both messages, distinctly, when the Sun and Moon are both ambiguous", () => {
    const natal = makeNatalChart();
    natal.bodies.Sun = makeNatalBodyPosition("Sun", 0, true);
    natal.bodies.Moon = makeNatalBodyPosition("Moon", 0, true);
    const messages = explainAmbiguity(natal);
    expect(messages).toContain(CUSP_MESSAGE);
    expect(messages).toContain(MOON_CUSP_MESSAGE);
    expect(messages).toHaveLength(2);
  });

  it("flags an unreliable Ascendant with its reason", () => {
    const natal = makeNatalChart({
      ascendant: { status: "unreliable", reason: "too close to the poles" },
    });
    const messages = explainAmbiguity(natal);
    expect(messages.some((message) => message.includes("too close to the poles"))).toBe(true);
  });
});

describe("explainDisclaimer (oracle-2au)", () => {
  it("returns the disclaimer message for a disclaimer-flagged verdict", () => {
    const outcome = makeVerdictOutcome({ disclaimer: true });
    expect(explainDisclaimer(outcome)).toBe(DISCLAIMER_MESSAGE);
  });

  it("returns undefined for a non-disclaimer verdict", () => {
    const outcome = makeVerdictOutcome({ disclaimer: false });
    expect(explainDisclaimer(outcome)).toBeUndefined();
  });

  it("returns undefined for a recusal outcome", () => {
    expect(explainDisclaimer({ kind: "recusal" })).toBeUndefined();
  });

  it("returns undefined for a needs-detail outcome", () => {
    expect(explainDisclaimer({ kind: "needs-detail" })).toBeUndefined();
  });
});
