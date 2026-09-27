import { describe, expect, it, vi } from "vitest";
import { JevOracle, OracleError } from "./oracle-jev";
import type { VerdictInput } from "./oracle";
import { signForLongitude, type BodyPosition } from "./sky";

// NOTE: no real network calls. Every test injects a fake `fetchImpl` (or, in
// the "default fetch" test, stubs the global `fetch`) so nothing here ever
// leaves the process. Request/response shapes are cross-checked against
// docs/jev-openrouter.md and worker/handler.ts/handler.test.ts's accepted
// shapes (see WORKER_URL and VALID_BODY-style assertions below).

const WORKER_URL = "https://cosmic-oracle-worker.example.workers.dev";

/** A well-formed Worker success body, per docs/jev-openrouter.md's "Response". */
function upstreamOk(answers: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      id: "gen-dec-test",
      model: "typesafe/jev-1.13-20260917",
      provider: "TypeSafe",
      answers,
      usage: { input_tokens: 10, output_tokens: 2, cost: 0.00001 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/** A Worker error body, per worker/handler.ts's `errorResponse`. */
function upstreamError(status: number, code: string, message = "generic message"): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * A minimal fake `Response` whose `.json()` resolves directly to `body`,
 * bypassing real JSON encoding entirely. Used only to simulate a malformed
 * or compromised upstream reply carrying values JSON itself cannot encode
 * (`NaN`, `Infinity`) -- `JSON.stringify({ noul: NaN })` silently produces
 * `{"noul":null}`, which would not exercise the `NaN`-specific guard this
 * file is regression-testing.
 */
function fakeJsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: () => Promise.resolve(body) } as unknown as Response;
}

function makeFetch(response: Response | Error): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function sentBody(calls: Array<{ url: string; init: RequestInit }>): Record<string, unknown> {
  const parsed: unknown = JSON.parse(String(calls[0]?.init.body));
  if (typeof parsed !== "object" || parsed === null) throw new Error("sent body was not an object");
  return parsed as Record<string, unknown>;
}

function makeBodyPosition(longitude: number, retrograde = false): BodyPosition {
  const { sign, degreeInSign } = signForLongitude(longitude);
  return { body: "Mars", longitude, sign, degreeInSign, retrograde };
}

function makeVerdictInput(overrides: Partial<VerdictInput> = {}): VerdictInput {
  return {
    category: "Mars",
    rulingBodyTransit: makeBodyPosition(15),
    aspects: [{ transit: "Mars", natal: "Sun", aspect: "trine", orb: 1.2, applying: true }],
    moonPhase: "full",
    activityText: "bowling",
    ...overrides,
  };
}

describe("JevOracle.classify (Call 1)", () => {
  it("happy path: sends state = activity text only and maps the answers to ClassificationResult", async () => {
    const { fetchImpl, calls } = makeFetch(
      upstreamOk({
        category: { type: "choice", choice: "Mars", confidence: 0.8, probabilities: { Mars: 0.8 } },
        consequential: { type: "noul", noul: 0.05 },
        vague: { type: "noul", noul: 0.1 },
      }),
    );
    const oracle = new JevOracle({ workerUrl: WORKER_URL, fetchImpl });

    const result = await oracle.classify("bowling with friends");

    expect(result).toEqual({ category: "Mars", consequential: 0.05, vague: 0.1 });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${WORKER_URL}/api/decide`);
    const init = calls[0]?.init;
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");

    const body = sentBody(calls);
    // state = activity text only, per spec -- a plain string.
    expect(body["state"]).toBe("bowling with friends");
    // No client-chosen `model` field (the Worker rejects one with 400).
    expect(Object.keys(body)).toEqual(["state", "questions"]);
    expect(body).not.toHaveProperty("model");

    const questions = body["questions"] as Record<string, Record<string, unknown>>;
    expect(Object.keys(questions).sort()).toEqual(["category", "consequential", "vague"]);
    expect(questions["category"]).toMatchObject({ type: "choice" });
    expect(typeof questions["category"]?.["instructions"]).toBe("string");
    expect(questions["category"]?.["criteria"]).toMatchObject({
      Mars: expect.any(String),
      Venus: expect.any(String),
      Mercury: expect.any(String),
      Jupiter: expect.any(String),
      Saturn: expect.any(String),
      Moon: expect.any(String),
      Sun: expect.any(String),
    });
    expect(questions["consequential"]).toEqual({
      type: "noul",
      instructions:
        "Is this a consequential real-life decision (health, medication, money, legal, safety, ending a relationship, quitting a job)?",
    });
    expect(questions["vague"]).toEqual({
      type: "noul",
      instructions: "Is this activity description too vague to categorize?",
    });
  });

  it("rejects with invalid_response when the category choice is not one of the seven ruling bodies", async () => {
    const { fetchImpl } = makeFetch(
      upstreamOk({
        category: { type: "choice", choice: "Pluto", confidence: 0.5, probabilities: {} },
        consequential: { type: "noul", noul: 0.1 },
        vague: { type: "noul", noul: 0.1 },
      }),
    );
    const oracle = new JevOracle({ workerUrl: WORKER_URL, fetchImpl });

    await expect(oracle.classify("bowling")).rejects.toMatchObject({ code: "invalid_response" });
  });
});

describe("JevOracle.verdict (Call 2)", () => {
  it("happy path: sends category/transit/aspects/moon phase/activity text and normalizes the score", async () => {
    const { fetchImpl, calls } = makeFetch(
      upstreamOk({
        favor: { type: "noul", noul: 0.81 },
        // 5 levels (this module's own choice) -> normalize via score / (5 - 1).
        intensity: { type: "score", score: 2, confidence: 0.9, probabilities: {}, legend: {} },
      }),
    );
    const oracle = new JevOracle({ workerUrl: WORKER_URL, fetchImpl });
    const input = makeVerdictInput();

    const result = await oracle.verdict(input);

    expect(result).toEqual({ favor: 0.81, intensity: 0.5 });

    // Both questions batched into a single request, per spec ("Batch both
    // questions in one call"), not two separate fetches.
    expect(calls).toHaveLength(1);

    const body = sentBody(calls);
    expect(body).not.toHaveProperty("model");
    expect(body["state"]).toEqual({
      category: "Mars",
      rulingBodyTransit: input.rulingBodyTransit,
      aspects: input.aspects,
      moonPhase: "full",
      activityText: "bowling",
    });

    const questions = body["questions"] as Record<string, Record<string, unknown>>;
    expect(Object.keys(questions).sort()).toEqual(["favor", "intensity"]);
    expect(questions["favor"]).toEqual({
      type: "noul",
      instructions: "Do the stars favor this activity for this person today?",
    });
    expect(questions["intensity"]?.["type"]).toBe("score");
    const levels = questions["intensity"]?.["criteria"];
    expect(Array.isArray(levels)).toBe(true);
    expect((levels as unknown[]).length).toBe(5);
    expect((levels as unknown[]).every((level) => typeof level === "string")).toBe(true);
  });

  it.each([
    [0, 0],
    [1, 0.25],
    [2, 0.5],
    [4, 1],
  ])("normalizes a raw score of %d (5 levels) to %d", async (rawScore, expectedIntensity) => {
    const { fetchImpl } = makeFetch(
      upstreamOk({
        favor: { type: "noul", noul: 0.5 },
        intensity: { type: "score", score: rawScore, confidence: 1, probabilities: {}, legend: {} },
      }),
    );
    const oracle = new JevOracle({ workerUrl: WORKER_URL, fetchImpl });
    const result = await oracle.verdict(makeVerdictInput());
    expect(result.intensity).toBeCloseTo(expectedIntensity);
  });

  it("rejects with invalid_response when the favor answer is missing", async () => {
    const { fetchImpl } = makeFetch(
      upstreamOk({ intensity: { type: "score", score: 1, confidence: 1, probabilities: {}, legend: {} } }),
    );
    const oracle = new JevOracle({ workerUrl: WORKER_URL, fetchImpl });
    await expect(oracle.verdict(makeVerdictInput())).rejects.toMatchObject({ code: "invalid_response" });
  });
});

describe("Worker error responses", () => {
  it.each([
    [429, "rate_limited"],
    [503, "unavailable"],
    [502, "upstream_error"],
    [400, "invalid_request"],
  ])("maps an HTTP %d Worker error body to OracleError code %s", async (status, code) => {
    const { fetchImpl } = makeFetch(upstreamError(status, code));
    const oracle = new JevOracle({ workerUrl: WORKER_URL, fetchImpl });

    await expect(oracle.classify("bowling")).rejects.toBeInstanceOf(OracleError);
    const { fetchImpl: fetchImpl2 } = makeFetch(upstreamError(status, code));
    const oracle2 = new JevOracle({ workerUrl: WORKER_URL, fetchImpl: fetchImpl2 });
    await expect(oracle2.classify("bowling")).rejects.toMatchObject({ code });
  });

  it("never leaks the Worker's own error message text -- OracleError uses its own copy", async () => {
    const { fetchImpl } = makeFetch(upstreamError(429, "rate_limited", "upstream leaked detail xyz"));
    const oracle = new JevOracle({ workerUrl: WORKER_URL, fetchImpl });
    try {
      await oracle.classify("bowling");
      expect.unreachable("expected classify() to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(OracleError);
      expect((error as Error).message).not.toContain("upstream leaked detail xyz");
    }
  });

  it("falls back to internal_error for an unrecognized error code", async () => {
    const { fetchImpl } = makeFetch(upstreamError(400, "some_future_code"));
    const oracle = new JevOracle({ workerUrl: WORKER_URL, fetchImpl });
    await expect(oracle.classify("bowling")).rejects.toMatchObject({ code: "internal_error" });
  });

  it("falls back to internal_error for a non-2xx status whose body isn't JSON", async () => {
    const { fetchImpl } = makeFetch(new Response("<html>gateway timeout</html>", { status: 504 }));
    const oracle = new JevOracle({ workerUrl: WORKER_URL, fetchImpl });
    await expect(oracle.classify("bowling")).rejects.toMatchObject({ code: "invalid_response" });
  });
});

describe("network failures", () => {
  it("maps fetch throwing to OracleError('network_error')", async () => {
    const { fetchImpl } = makeFetch(new TypeError("fetch failed"));
    const oracle = new JevOracle({ workerUrl: WORKER_URL, fetchImpl });
    await expect(oracle.classify("bowling")).rejects.toMatchObject({ code: "network_error" });
  });

  it("maps a 200 response with a non-JSON body to invalid_response", async () => {
    const { fetchImpl } = makeFetch(new Response("not json", { status: 200 }));
    const oracle = new JevOracle({ workerUrl: WORKER_URL, fetchImpl });
    await expect(oracle.classify("bowling")).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("maps a 200 response missing `answers` to invalid_response", async () => {
    const { fetchImpl } = makeFetch(new Response(JSON.stringify({ id: "x" }), { status: 200 }));
    const oracle = new JevOracle({ workerUrl: WORKER_URL, fetchImpl });
    await expect(oracle.classify("bowling")).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("uses the global fetch by default when no fetchImpl is injected", async () => {
    const response = upstreamOk({
      category: { type: "choice", choice: "Sun", confidence: 0.9, probabilities: {} },
      consequential: { type: "noul", noul: 0.05 },
      vague: { type: "noul", noul: 0.05 },
    });
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    try {
      const oracle = new JevOracle({ workerUrl: WORKER_URL });
      const result = await oracle.classify("karaoke night");
      expect(result.category).toBe("Sun");
      expect(spy).toHaveBeenCalledWith(`${WORKER_URL}/api/decide`, expect.anything());
    } finally {
      spy.mockRestore();
    }
  });
});

describe("request construction", () => {
  it("never includes a client-chosen model field in either call", async () => {
    const { fetchImpl: fetch1, calls: calls1 } = makeFetch(
      upstreamOk({
        category: { type: "choice", choice: "Mars", confidence: 0.8, probabilities: {} },
        consequential: { type: "noul", noul: 0.05 },
        vague: { type: "noul", noul: 0.05 },
      }),
    );
    await new JevOracle({ workerUrl: WORKER_URL, fetchImpl: fetch1 }).classify("bowling");
    expect(sentBody(calls1)).not.toHaveProperty("model");

    const { fetchImpl: fetch2, calls: calls2 } = makeFetch(
      upstreamOk({
        favor: { type: "noul", noul: 0.5 },
        intensity: { type: "score", score: 1, confidence: 1, probabilities: {}, legend: {} },
      }),
    );
    await new JevOracle({ workerUrl: WORKER_URL, fetchImpl: fetch2 }).verdict(makeVerdictInput());
    expect(sentBody(calls2)).not.toHaveProperty("model");
  });

  it("strips a trailing slash from the configured worker URL", async () => {
    const { fetchImpl, calls } = makeFetch(
      upstreamOk({
        category: { type: "choice", choice: "Mars", confidence: 0.8, probabilities: {} },
        consequential: { type: "noul", noul: 0.05 },
        vague: { type: "noul", noul: 0.05 },
      }),
    );
    const oracle = new JevOracle({ workerUrl: `${WORKER_URL}/`, fetchImpl });
    await oracle.classify("bowling");
    expect(calls[0]?.url).toBe(`${WORKER_URL}/api/decide`);
  });
});

describe("malformed upstream numeric answers (never silently trusted)", () => {
  // `typeof NaN === "number"`, so a naive `typeof` check alone would let a
  // NaN "consequential"/"vague" probability through: route()'s `p >=
  // threshold` checks (oracle.ts) are `false` for NaN, which would silently
  // fall through to "proceed" instead of recusing on a consequential
  // decision -- contrary to the spec's "No verdicts on consequential
  // decisions, ever." These use fakeJsonResponse (bypassing real JSON
  // encoding, which cannot carry NaN/Infinity at all) to simulate a
  // buggy/compromised provider reply.

  it("rejects Call 1 with invalid_response when the consequential noul is NaN", async () => {
    const { fetchImpl } = makeFetch(
      fakeJsonResponse({
        answers: {
          category: { type: "choice", choice: "Mars", confidence: 0.8, probabilities: {} },
          consequential: { type: "noul", noul: Number.NaN },
          vague: { type: "noul", noul: 0.1 },
        },
      }),
    );
    const oracle = new JevOracle({ workerUrl: WORKER_URL, fetchImpl });
    await expect(oracle.classify("bowling")).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("rejects Call 1 with invalid_response when the vague noul is Infinity", async () => {
    const { fetchImpl } = makeFetch(
      fakeJsonResponse({
        answers: {
          category: { type: "choice", choice: "Mars", confidence: 0.8, probabilities: {} },
          consequential: { type: "noul", noul: 0.1 },
          vague: { type: "noul", noul: Number.POSITIVE_INFINITY },
        },
      }),
    );
    const oracle = new JevOracle({ workerUrl: WORKER_URL, fetchImpl });
    await expect(oracle.classify("bowling")).rejects.toMatchObject({ code: "invalid_response" });
  });

  it.each([1.5, -0.2])("rejects Call 1 with invalid_response when a noul probability (%d) is out of [0, 1]", async (noul) => {
    const { fetchImpl } = makeFetch(
      fakeJsonResponse({
        answers: {
          category: { type: "choice", choice: "Mars", confidence: 0.8, probabilities: {} },
          consequential: { type: "noul", noul },
          vague: { type: "noul", noul: 0.1 },
        },
      }),
    );
    const oracle = new JevOracle({ workerUrl: WORKER_URL, fetchImpl });
    await expect(oracle.classify("bowling")).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("rejects Call 2 with invalid_response when the intensity score is NaN", async () => {
    const { fetchImpl } = makeFetch(
      fakeJsonResponse({
        answers: {
          favor: { type: "noul", noul: 0.5 },
          intensity: { type: "score", score: Number.NaN, confidence: 1, probabilities: {}, legend: {} },
        },
      }),
    );
    const oracle = new JevOracle({ workerUrl: WORKER_URL, fetchImpl });
    await expect(oracle.verdict(makeVerdictInput())).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("rejects Call 2 with invalid_response when the favor noul is NaN", async () => {
    const { fetchImpl } = makeFetch(
      fakeJsonResponse({
        answers: {
          favor: { type: "noul", noul: Number.NaN },
          intensity: { type: "score", score: 2, confidence: 1, probabilities: {}, legend: {} },
        },
      }),
    );
    const oracle = new JevOracle({ workerUrl: WORKER_URL, fetchImpl });
    await expect(oracle.verdict(makeVerdictInput())).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("rejects Call 2 with invalid_response when the intensity score is negative", async () => {
    const { fetchImpl } = makeFetch(
      fakeJsonResponse({
        answers: {
          favor: { type: "noul", noul: 0.5 },
          intensity: { type: "score", score: -1, confidence: 1, probabilities: {}, legend: {} },
        },
      }),
    );
    const oracle = new JevOracle({ workerUrl: WORKER_URL, fetchImpl });
    await expect(oracle.verdict(makeVerdictInput())).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("rejects Call 2 with invalid_response when the intensity score exceeds the level count's range (5 levels -> max index 4)", async () => {
    const { fetchImpl } = makeFetch(
      fakeJsonResponse({
        answers: {
          favor: { type: "noul", noul: 0.5 },
          intensity: { type: "score", score: 5, confidence: 1, probabilities: {}, legend: {} },
        },
      }),
    );
    const oracle = new JevOracle({ workerUrl: WORKER_URL, fetchImpl });
    await expect(oracle.verdict(makeVerdictInput())).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("accepts an intensity score exactly at the top of the range (4 for 5 levels)", async () => {
    const { fetchImpl } = makeFetch(
      fakeJsonResponse({
        answers: {
          favor: { type: "noul", noul: 0.5 },
          intensity: { type: "score", score: 4, confidence: 1, probabilities: {}, legend: {} },
        },
      }),
    );
    const oracle = new JevOracle({ workerUrl: WORKER_URL, fetchImpl });
    const result = await oracle.verdict(makeVerdictInput());
    expect(result.intensity).toBe(1);
  });
});
