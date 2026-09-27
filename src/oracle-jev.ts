/**
 * `JevOracle` (oracle-rwy): the real `Oracle` implementation, talking only to
 * our Cloudflare Worker proxy (`POST /api/decide`, see worker/handler.ts) --
 * never to OpenRouter directly, and never carrying `OPENROUTER_API_KEY`
 * (which does not exist on the client at all).
 *
 * Request/response shapes are per docs/jev-openrouter.md and
 * worker/handler.ts's validation:
 * - Request body is exactly `{ state, questions }`. The Worker adds `model`
 *   itself (from `JEV_MODEL`); a client-supplied `model` field is rejected
 *   with 400, so this module never sends one.
 * - `state` is a string, array, or plain object.
 * - `questions` is a map of our own question ids -> `{ type, instructions,
 *   criteria }`, `type` one of `noul` | `choice` | `score`.
 * - A successful reply is `{ id, model, provider, answers, usage }`; only
 *   `answers` is read here (the fuller `id`/`model`/`provider`/`usage`
 *   fields are not needed by anything this module returns).
 * - Noul answers carry `noul` (probability of "yes"); Choice answers carry
 *   `choice` (the top option); Score answers carry `score`, a 0-indexed,
 *   probability-weighted position on an N-level scale, normalized to [0, 1]
 *   via `score / (levels - 1)`.
 * - Errors are `{ error: { code, message } }`, `code` one of the
 *   `WorkerErrorCode`s transcribed below from worker/handler.ts's
 *   `ErrorCode` union.
 *
 * Reuses oracle.ts's `Oracle`/`ClassificationResult`/`VerdictInput`/
 * `VerdictAnswer`/`RulingBody`/`Noul`/`Intensity` types rather than
 * redeclaring chart or answer shapes.
 */
import type { ClassificationResult, Intensity, Noul, Oracle, RulingBody, VerdictAnswer, VerdictInput } from "./oracle";
import { TRANSIT_BODIES } from "./sky";

/** The Worker's route, per worker/handler.ts's `ROUTE`. Not imported from worker/ (a separate deploy target). */
const DECIDE_ROUTE = "/api/decide";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * The exact error codes the Worker can return, transcribed from
 * worker/handler.ts's `ErrorCode` union (see that file's `respond`/
 * `errorResponse`/`upstreamFailure` for where each one is produced).
 */
const WORKER_ERROR_CODES = [
  "origin_not_allowed",
  "not_found",
  "method_not_allowed",
  "server_misconfigured",
  "unsupported_media_type",
  "payload_too_large",
  "invalid_json",
  "invalid_request",
  "rate_limited",
  "unavailable",
  "upstream_error",
  "internal_error",
] as const;

type WorkerErrorCode = (typeof WORKER_ERROR_CODES)[number];

/**
 * Two additional codes for failures that happen entirely on the client side,
 * before or after talking to a well-behaved Worker: `fetch` itself throwing
 * (offline, DNS failure, CORS rejection, ...) and a response that cannot be
 * parsed as JSON or does not match the documented shape at all (wrong host,
 * a proxy/CDN error page, a future incompatible Worker version, ...).
 */
const CLIENT_ERROR_CODES = ["network_error", "invalid_response"] as const;

type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[number];

export type OracleErrorCode = WorkerErrorCode | ClientErrorCode;

/**
 * Own, fixed copy per code -- never the Worker's (or upstream's) message
 * text. The Worker already scrubs upstream detail before this module ever
 * sees a response, but this module does not re-introduce any risk of
 * echoing server-authored text back into the app regardless: every
 * `OracleError` message here is one of this module's own strings.
 */
const ORACLE_ERROR_MESSAGES: Record<OracleErrorCode, string> = {
  origin_not_allowed: "This app's origin is not allowed to reach the oracle.",
  not_found: "The oracle endpoint was not found.",
  method_not_allowed: "The oracle rejected the request method.",
  server_misconfigured: "The oracle is not configured.",
  unsupported_media_type: "The oracle rejected the request's content type.",
  payload_too_large: "The request was too large for the oracle.",
  invalid_json: "The request could not be understood by the oracle.",
  invalid_request: "The oracle rejected the request as invalid.",
  rate_limited: "The oracle is busy. Try again shortly.",
  unavailable: "The oracle is unavailable right now.",
  upstream_error: "The oracle could not answer. Try again.",
  internal_error: "Something went wrong reaching the oracle.",
  network_error: "Could not reach the oracle. Check your connection and try again.",
  invalid_response: "The oracle sent back something unexpected.",
};

/**
 * Typed, catchable failure for every `JevOracle` error path: a Worker error
 * response, a network failure, or a response that doesn't match the
 * documented shape. `Oracle.classify`/`Oracle.verdict` return plain
 * `Promise`s (see oracle.ts), so this is thrown (i.e. surfaces as a promise
 * rejection) rather than returned as a Result -- that keeps `JevOracle`
 * satisfying the existing `Oracle` interface exactly, and callers can
 * `catch`/`.catch()` it like any other typed error.
 */
export class OracleError extends Error {
  readonly code: OracleErrorCode;

  constructor(code: OracleErrorCode) {
    super(ORACLE_ERROR_MESSAGES[code]);
    this.name = "OracleError";
    this.code = code;
  }
}

function isKnownWorkerErrorCode(value: unknown): value is WorkerErrorCode {
  return typeof value === "string" && (WORKER_ERROR_CODES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Request shapes (docs/jev-openrouter.md's Question shapes)
// ---------------------------------------------------------------------------

type NoulQuestionBody = {
  type: "noul";
  instructions: string;
};

type ChoiceQuestionBody = {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
};

type ScoreQuestionBody = {
  type: "score";
  instructions: string;
  criteria: string[];
};

type QuestionBody = NoulQuestionBody | ChoiceQuestionBody | ScoreQuestionBody;

interface DecideRequestBody {
  state: string | unknown[] | Record<string, unknown>;
  questions: Record<string, QuestionBody>;
}

// ---------------------------------------------------------------------------
// Response shapes (docs/jev-openrouter.md's Response, narrowed to what this
// module reads: `noul`/`choice`/`score` answers, not `confidence`,
// `probabilities`, or `legend`).
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A Noul answer's value is documented (docs/jev-openrouter.md) as a
 * probability in [0, 1]. `typeof value.noul === "number"` alone is not
 * enough: `NaN` is a `number`, and a `NaN` "consequential"/"vague"
 * probability would silently compare `false` against `route`'s `>=`
 * threshold checks (oracle.ts), letting a malformed answer fall through to
 * "proceed" instead of recusing -- directly contrary to the spec's "No
 * verdicts on consequential decisions, ever." So this guard rejects `NaN`,
 * `Infinity`, and any value outside [0, 1] as an invalid response, not a
 * valid edge case to trust or silently clamp.
 */
function isNoulAnswer(value: unknown): value is { type: "noul"; noul: number } {
  return (
    isRecord(value) &&
    value.type === "noul" &&
    typeof value.noul === "number" &&
    Number.isFinite(value.noul) &&
    value.noul >= 0 &&
    value.noul <= 1
  );
}

function isChoiceAnswer(value: unknown): value is { type: "choice"; choice: string } {
  return isRecord(value) && value.type === "choice" && typeof value.choice === "string";
}

/**
 * A Score answer's `score` is documented as a 0-indexed position on an
 * N-level scale, so it must be finite and non-negative here (`NaN` is a
 * `number` too, and `normalizeScore`'s clamp does not catch it: `Math.max(0,
 * NaN)` is `NaN`, not `0`). The upper bound depends on how many levels this
 * question's own `criteria` array had, so it is checked separately in
 * `parseVerdict`, where that count is known.
 */
function isScoreAnswer(value: unknown): value is { type: "score"; score: number } {
  return (
    isRecord(value) && value.type === "score" && typeof value.score === "number" && Number.isFinite(value.score) && value.score >= 0
  );
}

function isRulingBody(value: string): value is RulingBody {
  return (TRANSIT_BODIES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Call 1: classify. Criteria/instructions transcribed from docs/spec.md
// section 2.
// ---------------------------------------------------------------------------

/**
 * Choice criteria for Call 1's category question: the seven ruling bodies,
 * described exactly per docs/spec.md section 2's category -> ruling body
 * list (one clause per body, in the spec's own order and wording).
 */
const CATEGORY_CRITERIA: Record<RulingBody, string> = {
  Mars: "Sports, exercise, competition, confrontation, bold new starts.",
  Venus: "Romance, dating, art, beauty, fashion, socializing, treats.",
  Mercury: "Communication, writing, emails, short trips, tech, contracts.",
  Jupiter: "Learning, long travel, games of chance, celebrations.",
  Saturn: "Work, chores, commitments, long-term planning.",
  Moon: "Home, cooking, family, rest, self-care.",
  Sun: "Performance, creative self-expression, being the center of attention.",
};

/**
 * Instructions for Call 1's category question. Not a verbatim spec quote
 * (the spec gives criteria per body but no single instructions sentence for
 * this question, unlike the two Nouls below) -- worded to match the
 * criteria's own framing ("ruling body").
 */
const CATEGORY_INSTRUCTIONS = "Which celestial body rules this activity?";

/** Verbatim from docs/spec.md section 2. */
const CONSEQUENTIAL_INSTRUCTIONS =
  "Is this a consequential real-life decision (health, medication, money, legal, safety, ending a relationship, quitting a job)?";

/** Verbatim from docs/spec.md section 2. */
const VAGUE_INSTRUCTIONS = "Is this activity description too vague to categorize?";

function classifyRequestBody(activityText: string): DecideRequestBody {
  return {
    // Call 1's state is "the activity text only" per spec -- a plain string
    // (docs/jev-openrouter.md allows string/object/array; a bare string is
    // the simplest state that is still exactly "the activity text").
    state: activityText,
    questions: {
      category: { type: "choice", instructions: CATEGORY_INSTRUCTIONS, criteria: CATEGORY_CRITERIA },
      consequential: { type: "noul", instructions: CONSEQUENTIAL_INSTRUCTIONS },
      vague: { type: "noul", instructions: VAGUE_INSTRUCTIONS },
    },
  };
}

function parseClassification(answers: Record<string, unknown>): ClassificationResult {
  const category = answers["category"];
  const consequential = answers["consequential"];
  const vague = answers["vague"];
  if (!isChoiceAnswer(category) || !isRulingBody(category.choice)) {
    throw new OracleError("invalid_response");
  }
  if (!isNoulAnswer(consequential) || !isNoulAnswer(vague)) {
    throw new OracleError("invalid_response");
  }
  return {
    category: category.choice,
    consequential: consequential.noul,
    vague: vague.noul,
  };
}

// ---------------------------------------------------------------------------
// Call 2: verdict.
// ---------------------------------------------------------------------------

/** Verbatim from docs/spec.md section 2. */
const FAVOR_INSTRUCTIONS = "Do the stars favor this activity for this person today?";

/**
 * Instructions for Call 2's intensity Score. The spec only says "cosmic
 * intensity (0-1), used only for flavor copy", with no exact wording, so
 * this is this module's own choice.
 */
const INTENSITY_INSTRUCTIONS = "How intense are today's cosmic influences on this activity?";

/**
 * Level descriptions for Call 2's intensity Score. docs/jev-openrouter.md
 * allows 2 to 10 levels; this module picks 5 as a middle ground -- enough
 * spread to make "firmly"-vs-"tentatively"-style flavor copy feel graded
 * rather than binary, without so many levels that each one is
 * indistinguishable from its neighbors. Ordered faintest to strongest, per
 * docs/jev-openrouter.md's "ordered array of level descriptions".
 */
const INTENSITY_LEVELS = [
  "Barely a cosmic murmur",
  "A mild celestial nudge",
  "A noticeable planetary pull",
  "A strong astral push",
  "An overwhelming cosmic surge",
] as const;

/** `score / (levels - 1)`, per docs/jev-openrouter.md's normalization rule. */
function normalizeScore(score: number, levels: number): Intensity {
  const normalized = score / (levels - 1);
  return Math.min(1, Math.max(0, normalized));
}

function verdictRequestBody(input: VerdictInput): DecideRequestBody {
  // Call 2's state is "category, ruling body's transit position and
  // retrograde status, relevant aspect list, Moon phase, the activity text"
  // per spec -- exactly `VerdictInput`'s own fields, serialized as a plain
  // object (docs/jev-openrouter.md allows an object `state`). Built as a new
  // object literal (rather than reusing `input` directly) only to satisfy
  // `DecideRequestBody["state"]`'s `Record<string, unknown>` type.
  const state: Record<string, unknown> = {
    category: input.category,
    rulingBodyTransit: input.rulingBodyTransit,
    aspects: input.aspects,
    moonPhase: input.moonPhase,
    activityText: input.activityText,
  };
  return {
    state,
    questions: {
      favor: { type: "noul", instructions: FAVOR_INSTRUCTIONS },
      intensity: { type: "score", instructions: INTENSITY_INSTRUCTIONS, criteria: [...INTENSITY_LEVELS] },
    },
  };
}

/**
 * Float tolerance for the score upper-bound check below: `score` is a
 * probability-weighted average of 0..(levels - 1), so it cannot legitimately
 * exceed `levels - 1`, but a tiny amount of floating-point slack keeps an
 * honest, exactly-at-the-top answer (e.g. `score: 4.000000000000001`) from
 * being wrongly rejected.
 */
const SCORE_UPPER_BOUND_EPSILON = 1e-6;

function parseVerdict(answers: Record<string, unknown>): VerdictAnswer {
  const favor = answers["favor"];
  const intensity = answers["intensity"];
  if (!isNoulAnswer(favor) || !isScoreAnswer(intensity)) {
    throw new OracleError("invalid_response");
  }
  // isScoreAnswer only checked "finite and >= 0" (it has no way to know how
  // many levels this question's own criteria had); the upper bound is
  // checked here, where INTENSITY_LEVELS's length is known. An out-of-range
  // score is a malformed-response case, not a valid edge case to clamp
  // silently (see normalizeScore's doc comment and isScoreAnswer's).
  const maxScore = INTENSITY_LEVELS.length - 1;
  if (intensity.score > maxScore + SCORE_UPPER_BOUND_EPSILON) {
    throw new OracleError("invalid_response");
  }
  const favorValue: Noul = favor.noul;
  return {
    favor: favorValue,
    intensity: normalizeScore(intensity.score, INTENSITY_LEVELS.length),
  };
}

// ---------------------------------------------------------------------------
// JevOracle
// ---------------------------------------------------------------------------

/** Constructor options for `JevOracle`. */
export interface JevOracleOptions {
  /** Base URL of the deployed Worker (see src/config.ts's `WORKER_URL`), without a trailing slash requirement. */
  workerUrl: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * The real `Oracle`: Call 1 (classify) and Call 2 (verdict), each a single
 * `POST` to the Worker's `/api/decide` with all of that call's questions
 * batched into one request, per spec.
 */
export class JevOracle implements Oracle {
  private readonly workerUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: JevOracleOptions) {
    this.workerUrl = options.workerUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async classify(activityText: string): Promise<ClassificationResult> {
    const answers = await this.decide(classifyRequestBody(activityText));
    return parseClassification(answers);
  }

  async verdict(input: VerdictInput): Promise<VerdictAnswer> {
    const answers = await this.decide(verdictRequestBody(input));
    return parseVerdict(answers);
  }

  /**
   * Calls the Worker's `/api/decide` and returns its `answers` object, or
   * throws a typed `OracleError` for every failure mode: `fetch` throwing
   * (network/CORS failure), a non-JSON body, a non-2xx status (mapped from
   * the Worker's `{ error: { code, message } }`, falling back to
   * `internal_error` for any status/body this client does not recognize),
   * or a 2xx body that isn't `{ answers: {...} }`.
   */
  private async decide(body: DecideRequestBody): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.workerUrl}${DECIDE_ROUTE}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      throw new OracleError("network_error");
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new OracleError("invalid_response");
    }

    if (!response.ok) {
      const code =
        isRecord(json) && isRecord(json.error) && isKnownWorkerErrorCode(json.error.code)
          ? json.error.code
          : "internal_error";
      throw new OracleError(code);
    }

    if (!isRecord(json) || !isRecord(json.answers)) {
      throw new OracleError("invalid_response");
    }
    return json.answers;
  }
}
