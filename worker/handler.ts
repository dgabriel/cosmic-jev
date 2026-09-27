/**
 * Cosmic Oracle Worker: a thin proxy from the browser to Jev via OpenRouter.
 * See docs/jev-openrouter.md for the upstream request/response shapes.
 *
 * Route:  POST /api/decide   body: { state, questions }
 *   - Validates and size-limits the body, then forwards
 *     { model, state, questions } to https://openrouter.ai/api/v1/systemone.
 *   - The model comes from the JEV_MODEL var (default typesafe/jev-1.13);
 *     clients cannot choose it, and a `model` field in the body is rejected.
 *   - A successful upstream reply must be a JSON object with an `answers`
 *     object. Only { id, model, provider, answers, usage } is forwarded; any
 *     other field is dropped. Anything else (including a 200 carrying an
 *     `error` body) becomes a generic 502.
 *   - Upstream 429 and 5xx/529 (and network errors/timeouts) are retried with
 *     exponential backoff (3 attempts, 250 then 500 ms, 10 s per attempt);
 *     other 4xx are not. Retry-After is not honored. Upstream failures are
 *     mapped to generic { error: { code, message } } responses that carry no
 *     upstream detail. Any unexpected throw becomes a generic 500.
 *
 * Secrets and privacy:
 *   - OPENROUTER_API_KEY is a Worker secret. It is used only in the outbound
 *     Authorization header and is never logged or returned.
 *   - Nothing about the request (birthdates, activity text) is stored or
 *     logged. This file makes no console calls on purpose.
 *
 * CORS: ALLOWED_ORIGINS is a comma-separated allowlist of exact origins. The
 * Origin is echoed only when it is on the list (never `*`). A request that
 * carries a non-allowlisted Origin is rejected with 403. A request with no
 * Origin header (curl, server-to-server) is not a browser CORS request and is
 * served without CORS headers.
 */

/** Bindings. Hand-written because the project has no @cloudflare/workers-types. */
export interface Env {
  /** Secret. Set with `wrangler secret put` or worker/.dev.vars locally. */
  OPENROUTER_API_KEY?: string;
  /** Non-secret var. Defaults to DEFAULT_JEV_MODEL. */
  JEV_MODEL?: string;
  /** Non-secret var. Comma-separated exact origins, e.g. "https://a.example,http://localhost:5173". */
  ALLOWED_ORIGINS?: string;
}

export const ROUTE = "/api/decide";
export const UPSTREAM_URL = "https://openrouter.ai/api/v1/systemone";
export const DEFAULT_JEV_MODEL = "typesafe/jev-1.13";

/** Request body cap in bytes. Real bodies are a few KB (chart summary + activity). */
export const MAX_BODY_BYTES = 32 * 1024;
const MAX_QUESTIONS = 8;
const MAX_QUESTION_ID_LENGTH = 64;
/** Limits from docs/jev-openrouter.md. */
const MAX_CHOICE_OPTIONS = 255;
const MIN_SCORE_LEVELS = 2;
const MAX_SCORE_LEVELS = 10;

/**
 * Total upstream attempts (1 try + 2 retries) and the first backoff delay
 * (delays are 250 ms then 500 ms). Worst case is about 3 x 10 s + 0.75 s.
 */
export const MAX_ATTEMPTS = 3;
export const RETRY_BASE_DELAY_MS = 250;
export const UPSTREAM_TIMEOUT_MS = 10_000;

/**
 * Keys that must never be used as question ids or choice options: copying them
 * into a plain object would set the prototype instead of an own property.
 */
const RESERVED_KEYS: readonly string[] = ["__proto__", "constructor", "prototype"];

/** `application/json`, optionally followed by only a charset parameter. */
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=[\w.:-]+)?$/i;

// ---------------------------------------------------------------------------
// Request model
// ---------------------------------------------------------------------------

type NoulQuestion = {
  type: "noul";
  instructions: string;
  criteria?: { true?: string; false?: string };
};
type ChoiceQuestion = {
  type: "choice";
  instructions: string;
  criteria: Record<string, string | null>;
};
type ScoreQuestion = {
  type: "score";
  instructions: string;
  criteria: string[];
};
type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

type DecideState = string | unknown[] | Record<string, unknown>;

type DecideRequest = {
  state: DecideState;
  questions: Record<string, Question>;
};

type Result<T> = { ok: true; value: T } | { ok: false; message: string };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = <T>(message: string): Result<T> => ({ ok: false, message });

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hasOnlyKeys(v: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(v).every((k) => allowed.includes(k));
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function validateQuestion(id: string, raw: unknown): Result<Question> {
  const at = `questions.${id}`;
  if (!isRecord(raw)) return fail(`${at} must be an object`);
  const { type, instructions, criteria } = raw;
  if (!nonEmptyString(instructions)) return fail(`${at}.instructions must be a non-empty string`);

  switch (type) {
    case "noul": {
      if (!hasOnlyKeys(raw, ["type", "instructions", "criteria"])) {
        return fail(`${at} has unsupported fields`);
      }
      if (criteria === undefined) return ok({ type, instructions });
      if (!isRecord(criteria) || !hasOnlyKeys(criteria, ["true", "false"])) {
        return fail(`${at}.criteria must be an object with only "true" and "false"`);
      }
      const out: { true?: string; false?: string } = {};
      for (const key of ["true", "false"] as const) {
        const value = criteria[key];
        if (value === undefined) continue;
        if (typeof value !== "string") return fail(`${at}.criteria.${key} must be a string`);
        out[key] = value;
      }
      return ok({ type, instructions, criteria: out });
    }
    case "choice": {
      if (!hasOnlyKeys(raw, ["type", "instructions", "criteria"])) {
        return fail(`${at} has unsupported fields`);
      }
      if (!isRecord(criteria)) return fail(`${at}.criteria must be an object`);
      const options = Object.entries(criteria);
      if (options.length === 0 || options.length > MAX_CHOICE_OPTIONS) {
        return fail(`${at}.criteria must have 1 to ${MAX_CHOICE_OPTIONS} options`);
      }
      const out: Record<string, string | null> = {};
      for (const [option, description] of options) {
        if (RESERVED_KEYS.includes(option)) {
          return fail(`${at}.criteria has a reserved option name`);
        }
        if (description !== null && typeof description !== "string") {
          return fail(`${at}.criteria values must be strings or null`);
        }
        out[option] = description;
      }
      return ok({ type, instructions, criteria: out });
    }
    case "score": {
      if (!hasOnlyKeys(raw, ["type", "instructions", "criteria"])) {
        return fail(`${at} has unsupported fields`);
      }
      if (
        !Array.isArray(criteria) ||
        criteria.length < MIN_SCORE_LEVELS ||
        criteria.length > MAX_SCORE_LEVELS ||
        !criteria.every((level): level is string => typeof level === "string")
      ) {
        return fail(
          `${at}.criteria must be an array of ${MIN_SCORE_LEVELS} to ${MAX_SCORE_LEVELS} strings`,
        );
      }
      return ok({ type, instructions, criteria: [...criteria] });
    }
    default:
      return fail(`${at}.type must be one of noul, choice, score`);
  }
}

function validateDecideRequest(raw: unknown): Result<DecideRequest> {
  if (!isRecord(raw)) return fail("body must be a JSON object");
  if (!hasOnlyKeys(raw, ["state", "questions"])) {
    return fail("body may contain only state and questions");
  }
  const { state, questions } = raw;
  if (typeof state !== "string" && !Array.isArray(state) && !isRecord(state)) {
    return fail("state must be a string, object, or array");
  }
  if (!isRecord(questions)) return fail("questions must be an object");
  const entries = Object.entries(questions);
  if (entries.length === 0 || entries.length > MAX_QUESTIONS) {
    return fail(`questions must contain 1 to ${MAX_QUESTIONS} entries`);
  }
  const out: Record<string, Question> = {};
  for (const [id, rawQuestion] of entries) {
    if (id.length === 0 || id.length > MAX_QUESTION_ID_LENGTH) {
      return fail(`question ids must be 1 to ${MAX_QUESTION_ID_LENGTH} characters`);
    }
    if (RESERVED_KEYS.includes(id)) return fail("question id is reserved");
    const parsed = validateQuestion(id, rawQuestion);
    if (!parsed.ok) return parsed;
    out[id] = parsed.value;
  }
  return ok({ state, questions: out });
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

type ErrorCode =
  | "origin_not_allowed"
  | "not_found"
  | "method_not_allowed"
  | "server_misconfigured"
  | "unsupported_media_type"
  | "payload_too_large"
  | "invalid_json"
  | "invalid_request"
  | "rate_limited"
  | "unavailable"
  | "upstream_error"
  | "internal_error";

function respond(
  status: number,
  body: string | null,
  extra: Record<string, string> = {},
): Response {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    Vary: "Origin",
    ...extra,
  });
  if (body !== null) headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(body, { status, headers });
}

function errorResponse(
  status: number,
  code: ErrorCode,
  message: string,
  extra: Record<string, string> = {},
): Response {
  return respond(status, JSON.stringify({ error: { code, message } }), extra);
}

function parseAllowedOrigins(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}

/**
 * Read the request body as text, giving up as soon as it exceeds `max` bytes
 * (Content-Length can be absent or wrong, so count what actually arrives).
 * Returns null when the limit is exceeded.
 */
async function readBodyLimited(request: Request, max: number): Promise<string | null> {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && Number(declared) > max) return null;
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

// ---------------------------------------------------------------------------
// Upstream call
// ---------------------------------------------------------------------------

/** Injectable so tests never touch the network or wait on real timers. */
export interface Deps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  /** Per-attempt upstream timeout. Defaults to UPSTREAM_TIMEOUT_MS; tests shorten it. */
  timeoutMs?: number;
}

type UpstreamResult =
  | { kind: "ok"; text: string }
  /** status is null for network errors and timeouts. */
  | { kind: "error"; status: number | null };

function isRetryable(status: number | null): boolean {
  return status === null || status === 429 || status >= 500;
}

async function callUpstream(deps: Deps, apiKey: string, payload: string): Promise<UpstreamResult> {
  let status: number | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await deps.fetch(UPSTREAM_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: payload,
        signal: AbortSignal.timeout(deps.timeoutMs ?? UPSTREAM_TIMEOUT_MS),
      });
      if (res.ok) return { kind: "ok", text: await res.text() };
      status = res.status;
      // Free the connection; do not await (cancel can stall on some body types).
      void res.body?.cancel().catch(() => undefined);
    } catch {
      status = null;
    }
    if (!isRetryable(status) || attempt === MAX_ATTEMPTS - 1) break;
    await deps.sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
  }
  return { kind: "error", status };
}

/** Map an upstream failure to a generic response. Never includes upstream detail. */
function upstreamFailure(status: number | null, cors: Record<string, string>): Response {
  if (status === 429) {
    return errorResponse(429, "rate_limited", "The oracle is busy. Try again shortly.", cors);
  }
  // 401/402/403 are our account or key problems, not the caller's.
  if (status === 401 || status === 402 || status === 403) {
    return errorResponse(503, "unavailable", "The oracle is unavailable right now.", cors);
  }
  return errorResponse(502, "upstream_error", "The oracle could not answer. Try again.", cors);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Reduce an upstream success body to the whitelisted fields, or null if it is
 * not a JSON object with an `answers` object (e.g. a 200 carrying `error`).
 */
function whitelistUpstream(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.answers)) return null;
  const { id, model, provider, answers, usage } = parsed;
  return JSON.stringify({
    id: typeof id === "string" ? id : undefined,
    model: typeof model === "string" ? model : undefined,
    provider: typeof provider === "string" ? provider : undefined,
    answers,
    usage: isRecord(usage) ? usage : undefined,
  });
}

export function createHandler(deps: Deps): (request: Request, env: Env) => Promise<Response> {
  return async (request, env) => {
    try {
      return await handle(deps, request, env);
    } catch {
      // Unexpected failure (e.g. the body stream aborted). No exception text is returned.
      const origin = request.headers.get("Origin");
      const cors: Record<string, string> =
        origin !== null && parseAllowedOrigins(env.ALLOWED_ORIGINS).includes(origin)
          ? { "Access-Control-Allow-Origin": origin }
          : {};
      return errorResponse(500, "internal_error", "Something went wrong.", cors);
    }
  };
}

async function handle(deps: Deps, request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== ROUTE) {
    return errorResponse(404, "not_found", "Not found.");
  }

  const origin = request.headers.get("Origin");
  let cors: Record<string, string> = {};
  if (origin !== null) {
    if (!parseAllowedOrigins(env.ALLOWED_ORIGINS).includes(origin)) {
      return errorResponse(403, "origin_not_allowed", "Origin not allowed.");
    }
    cors = { "Access-Control-Allow-Origin": origin };
  }

  if (request.method === "OPTIONS") {
    if (origin === null) return respond(204, null);
    return respond(204, null, {
      ...cors,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    });
  }
  if (request.method !== "POST") {
    return errorResponse(405, "method_not_allowed", "Use POST.", {
      ...cors,
      Allow: "POST, OPTIONS",
    });
  }

  const apiKey = env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    return errorResponse(500, "server_misconfigured", "The oracle is not configured.", cors);
  }

  // Requiring JSON also forces a CORS preflight for browsers.
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!JSON_CONTENT_TYPE.test(contentType.trim())) {
    return errorResponse(415, "unsupported_media_type", "Send application/json.", cors);
  }

  const text = await readBodyLimited(request, MAX_BODY_BYTES);
  if (text === null) {
    return errorResponse(413, "payload_too_large", "Request body is too large.", cors);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return errorResponse(400, "invalid_json", "Request body is not valid JSON.", cors);
  }
  const validated = validateDecideRequest(parsed);
  if (!validated.ok) {
    return errorResponse(400, "invalid_request", validated.message, cors);
  }

  const model = env.JEV_MODEL?.trim() || DEFAULT_JEV_MODEL;
  const payload = JSON.stringify({
    model,
    state: validated.value.state,
    questions: validated.value.questions,
  });

  const upstream = await callUpstream(deps, apiKey, payload);
  if (upstream.kind === "error") return upstreamFailure(upstream.status, cors);

  const answer = whitelistUpstream(upstream.text);
  if (answer === null) return upstreamFailure(null, cors);
  return respond(200, answer, cors);
}
