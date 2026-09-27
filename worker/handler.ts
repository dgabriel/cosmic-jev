/**
 * Cosmic Oracle Worker: a thin proxy from the browser to Jev via OpenRouter.
 * See docs/jev-openrouter.md for the upstream request/response shapes.
 *
 * Route:  POST /api/decide   body: { state, questions }
 *   - Validates and size-limits the body, then forwards
 *     { model, state, questions } to https://openrouter.ai/api/v1/systemone.
 *
 * Route:  GET /api/admin/spend
 *   - Spend-ledger snapshot for admin.html: rolling-7-day and all-time spend
 *     per IP bucket. No auth by design (security by obscurity only; see
 *     docs/jev-openrouter.md). Exempt buckets are omitted from the rows so
 *     the operator's own IP is not published, but they count into total_usd.
 *
 * Spend throttle (see spendLedger.ts): before proxying, the caller's bucket
 *   (CF-Connecting-IP; IPv6 collapsed to /64) is checked against
 *   SPEND_CAP_USD_PER_IP in the SPEND_TRACKER Durable Object; at or over the
 *   rolling 7-day cap the request gets 429 rate_limited without an upstream
 *   call. After a successful upstream call its exact usage.cost is charged
 *   via waitUntil (FALLBACK_CHARGE_USD when the reply carries no numeric
 *   cost). THROTTLE_EXEMPT_IPS buckets skip the check but are still charged.
 *   A ledger or throttle-config failure answers 503 rather than proxying
 *   unbilled traffic, and an accounting failure after the upstream call is
 *   dropped -- the verdict must not fail because the meter did.
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
 *   - Request content (birthdates, activity text) is never stored or logged.
 *     The spend ledger keeps only the caller's IP-derived bucket, a timestamp
 *     and a dollar amount. This file makes no console calls on purpose.
 *
 * CORS: ALLOWED_ORIGINS is a comma-separated allowlist of exact origins. The
 * Origin is echoed only when it is on the list (never `*`). A request that
 * carries a non-allowlisted Origin is rejected with 403. A request with no
 * Origin header (curl, server-to-server) is not a browser CORS request and is
 * served without CORS headers.
 */

import {
  FALLBACK_CHARGE_USD,
  SPEND_WINDOW_DAYS,
  ipBucket,
  isExemptBucket,
  parseCap,
  roundUsd,
  type LedgerBucket,
} from "./spendLedger";

/** Hand-written because the project has no @cloudflare/workers-types. */

/** Structural subset of the SPEND_TRACKER Durable Object stub (spendLedger.ts). */
export interface SpendTrackerStub {
  fetch(request: Request): Promise<Response>;
}

/** Structural subset of a Durable Object namespace binding. */
export interface SpendTrackerNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): SpendTrackerStub;
}

/** ExecutionContext subset: charge the ledger after the response is sent. */
export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

/** Bindings. */
export interface Env {
  /** Secret. Set with `wrangler secret put` or worker/.dev.vars locally. */
  OPENROUTER_API_KEY?: string;
  /** Non-secret var. Defaults to DEFAULT_JEV_MODEL. */
  JEV_MODEL?: string;
  /** Non-secret var. Comma-separated exact origins, e.g. "https://a.example,http://localhost:5173". */
  ALLOWED_ORIGINS?: string;
  /** Durable Object binding. Absent binding = throttle misconfigured = 503. */
  SPEND_TRACKER?: SpendTrackerNamespace;
  /** Non-secret var. Rolling-7-day spend cap per IP bucket, e.g. "0.01". */
  SPEND_CAP_USD_PER_IP?: string;
  /** Secret. Comma-separated exempt buckets: IPv4 addresses, IPv6 /64 prefixes. */
  THROTTLE_EXEMPT_IPS?: string;
}

export const ROUTE = "/api/decide";
export const ADMIN_ROUTE = "/api/admin/spend";
export const UPSTREAM_URL = "https://openrouter.ai/api/v1/systemone";
export const DEFAULT_JEV_MODEL = "typesafe/jev-1.13";

/**
 * Request body cap in bytes. Real bodies are ~1-2 KB (chart summary +
 * activity); the cap also bounds the worst-case dollars one metered call can
 * spend between the pre-check and the charge.
 */
export const MAX_BODY_BYTES = 8 * 1024;

/** Client-facing message for a self-throttled 429 (distinct from the upstream-
 * 429 message in upstreamFailure so each is identifiable in tests and logs). */
export const THROTTLED_MESSAGE =
  "This network's free cosmic budget for the week is spent. More allowance opens up as last week's charges age out.";
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
 * Also extracts usage.cost for the spend charge.
 */
function whitelistUpstream(text: string): { body: string; costUsd: number | null } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.answers)) return null;
  const { id, model, provider, answers, usage } = parsed;
  const rawCost = isRecord(usage) ? usage.cost : undefined;
  const costUsd =
    typeof rawCost === "number" && Number.isFinite(rawCost) && rawCost >= 0 ? rawCost : null;
  return {
    body: JSON.stringify({
      id: typeof id === "string" ? id : undefined,
      model: typeof model === "string" ? model : undefined,
      provider: typeof provider === "string" ? provider : undefined,
      answers,
      usage: isRecord(usage) ? usage : undefined,
    }),
    costUsd,
  };
}

// ---------------------------------------------------------------------------
// Spend-ledger wire protocol (spendLedger.ts): JSON over stub.fetch.
// ---------------------------------------------------------------------------

/** Placeholder origin for requests to the Durable Object; only the path matters. */
const TRACKER_ORIGIN = "https://spend-tracker.internal";

function trackerRequest(path: string, body?: unknown): Request {
  return new Request(`${TRACKER_ORIGIN}${path}`, {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
}

async function ledgerWindowSpend(stub: SpendTrackerStub, bucket: string): Promise<number> {
  const res = await stub.fetch(trackerRequest("/check", { bucket }));
  if (!res.ok) throw new Error(`ledger check failed: ${res.status}`);
  const body: unknown = await res.json();
  const spent = isRecord(body) ? body.spent : undefined;
  if (typeof spent !== "number" || !Number.isFinite(spent)) {
    throw new Error("ledger check returned a malformed body");
  }
  return spent;
}

async function ledgerCharge(stub: SpendTrackerStub, bucket: string, usd: number): Promise<void> {
  const res = await stub.fetch(trackerRequest("/charge", { bucket, usd }));
  if (!res.ok) throw new Error(`ledger charge failed: ${res.status}`);
}

async function ledgerSnapshot(stub: SpendTrackerStub): Promise<LedgerBucket[]> {
  const res = await stub.fetch(trackerRequest("/snapshot"));
  if (!res.ok) throw new Error(`ledger snapshot failed: ${res.status}`);
  const body: unknown = await res.json();
  if (!isRecord(body) || !Array.isArray(body.buckets)) {
    throw new Error("ledger snapshot returned a malformed body");
  }
  return (body.buckets as Array<Partial<LedgerBucket>>).map((b, i) => {
    if (
      typeof b.bucket !== "string" ||
      typeof b.spend7dUsd !== "number" ||
      typeof b.totalUsd !== "number"
    ) {
      throw new Error(`ledger snapshot row ${i} is malformed`);
    }
    return {
      bucket: b.bucket,
      spend7dUsd: b.spend7dUsd,
      totalUsd: b.totalUsd,
      lastChargeMs: typeof b.lastChargeMs === "number" ? b.lastChargeMs : null,
    };
  });
}

export function createHandler(
  deps: Deps,
): (request: Request, env: Env, ctx?: ExecutionContextLike) => Promise<Response> {
  return async (request, env, ctx) => {
    try {
      return await handle(deps, request, env, ctx);
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

async function handle(
  deps: Deps,
  request: Request,
  env: Env,
  ctx?: ExecutionContextLike,
): Promise<Response> {
  const url = new URL(request.url);
  const route = url.pathname === ROUTE ? "decide" : url.pathname === ADMIN_ROUTE ? "admin" : null;
  if (route === null) {
    return errorResponse(404, "not_found", "Not found.");
  }
  const methods = route === "decide" ? "POST, OPTIONS" : "GET, OPTIONS";

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
      "Access-Control-Allow-Methods": methods,
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    });
  }
  if (request.method !== (route === "decide" ? "POST" : "GET")) {
    return errorResponse(405, "method_not_allowed", route === "decide" ? "Use POST." : "Use GET.", {
      ...cors,
      Allow: methods,
    });
  }

  if (route === "admin") return handleAdmin(env, cors);

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

  // --- Spend throttle (see the file header). Fail-closed on any ledger or
  // config problem: this feature exists to protect real money. The check is
  // skipped for exempt buckets, but they are still charged below.
  const bucket = ipBucket(request.headers.get("CF-Connecting-IP"));
  const exempt = isExemptBucket(bucket, env.THROTTLE_EXEMPT_IPS);
  const cap = parseCap(env.SPEND_CAP_USD_PER_IP);
  const tracker = env.SPEND_TRACKER;
  const stub = tracker !== undefined ? tracker.get(tracker.idFromName("ledger")) : null;
  if (stub === null || cap === null) {
    return errorResponse(503, "unavailable", "The oracle is unavailable right now.", cors);
  }
  if (!exempt) {
    let spent: number;
    try {
      spent = await ledgerWindowSpend(stub, bucket);
    } catch {
      return errorResponse(503, "unavailable", "The oracle is unavailable right now.", cors);
    }
    if (spent >= cap) {
      return errorResponse(429, "rate_limited", THROTTLED_MESSAGE, cors);
    }
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
  const charging = ledgerCharge(stub, bucket, answer.costUsd ?? FALLBACK_CHARGE_USD).catch(
    () => undefined, // a meter failure must not fail the verdict
  );
  if (ctx !== undefined) ctx.waitUntil(charging);
  else await charging; // tests and non-Workers runtimes observe the write
  return respond(200, answer.body, cors);
}

/**
 * GET /api/admin/spend: the ledger snapshot behind admin.html. Unmetered
 * (it spends nothing). Exempt buckets are filtered out of the rows -- the
 * whole point of the exemption list being a secret is that it names the
 * operator's IPs -- but their dollars still count in total_usd.
 */
async function handleAdmin(env: Env, cors: Record<string, string>): Promise<Response> {
  const tracker = env.SPEND_TRACKER;
  const stub = tracker !== undefined ? tracker.get(tracker.idFromName("ledger")) : null;
  const unavailable = () =>
    errorResponse(503, "unavailable", "The oracle is unavailable right now.", cors);
  if (stub === null) return unavailable();
  const nowMs = Date.now();
  let buckets: LedgerBucket[];
  try {
    buckets = await ledgerSnapshot(stub);
  } catch {
    return unavailable();
  }
  const visible = buckets
    .filter((b) => !isExemptBucket(b.bucket, env.THROTTLE_EXEMPT_IPS))
    .sort((a, b) => b.spend7dUsd - a.spend7dUsd || a.bucket.localeCompare(b.bucket));
  return respond(
    200,
    JSON.stringify({
      window_days: SPEND_WINDOW_DAYS,
      cap_usd: parseCap(env.SPEND_CAP_USD_PER_IP),
      generated_at: new Date(nowMs).toISOString(),
      total_usd: roundUsd(buckets.reduce((sum, b) => sum + b.totalUsd, 0)),
      buckets: visible.map((b) => ({
        bucket: b.bucket,
        spend_7d_usd: b.spend7dUsd,
        total_usd: b.totalUsd,
        last_charge_at: b.lastChargeMs === null ? null : new Date(b.lastChargeMs).toISOString(),
      })),
    }),
    cors,
  );
}
