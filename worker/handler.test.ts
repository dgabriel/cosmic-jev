import { describe, expect, it } from "vitest";
import {
  ADMIN_ROUTE,
  DEFAULT_JEV_MODEL,
  MAX_ATTEMPTS,
  MAX_BODY_BYTES,
  RETRY_BASE_DELAY_MS,
  ROUTE,
  THROTTLED_MESSAGE,
  UPSTREAM_TIMEOUT_MS,
  UPSTREAM_URL,
  createHandler,
  type Env,
  type SpendTrackerNamespace,
  type SpendTrackerStub,
} from "./handler";
import { FALLBACK_CHARGE_USD, mergeLedger } from "./spendLedger";

// A fake key, used only to prove the Worker never leaks whatever key it holds.
const KEY = "sk-or-test-FAKE-KEY-must-never-leak";
const APP_ORIGIN = "https://dgabriel.github.io";
const DEV_ORIGIN = "http://localhost:5173";
const URL_ = `https://worker.test${ROUTE}`;
const ADMIN_URL = `https://worker.test${ADMIN_ROUTE}`;

// --- fake SPEND_TRACKER namespaces (structural; spendLedger.ts logic has its own tests) ---

interface FakeCharge {
  bucket: string;
  usd: number;
  nowMs: number;
}

interface FakeTrackerStub extends SpendTrackerStub {
  charges: FakeCharge[];
  /** Make /check start failing, to prove the handler fails closed. */
  breakChecks(): void;
  /** Push a raw charge with a chosen timestamp (for admin snapshot tests). */
  seed(bucket: string, usd: number, nowMs: number): void;
}

/**
 * An in-memory spend tracker speaking the real wire protocol (JSON over
 * fetch, like spendLedger.ts's DO). With `realSums` true, /check sums every
 * charge for the bucket (the rolling-window SQL itself is covered by
 * spendLedger.test.ts); with false it always reports 0 so the throttle can
 * never fire -- used for the shared ENV so spend accumulation across the
 * suite can never 429 an unrelated test.
 */
function fakeSpendTracker(realSums = true): {
  namespace: SpendTrackerNamespace;
  stub: FakeTrackerStub;
} {
  const charges: FakeCharge[] = [];
  let checksBroken = false;
  const stub: FakeTrackerStub = {
    charges,
    breakChecks: () => {
      checksBroken = true;
    },
    seed: (bucket, usd, nowMs) => {
      charges.push({ bucket, usd, nowMs });
    },
    async fetch(request: Request): Promise<Response> {
      const { pathname } = new URL(request.url);
      if (request.method === "POST" && pathname === "/check") {
        if (checksBroken) return new Response("down", { status: 503 });
        const body = (await request.json()) as { bucket: string };
        const sum = realSums
          ? charges.filter((c) => c.bucket === body.bucket).reduce((s, c) => s + c.usd, 0)
          : 0;
        return Response.json({ spent: sum });
      }
      if (request.method === "POST" && pathname === "/charge") {
        const body = (await request.json()) as { bucket: string; usd: number };
        charges.push({ bucket: body.bucket, usd: body.usd, nowMs: Date.now() });
        return new Response(null, { status: 204 });
      }
      if (request.method === "GET" && pathname === "/snapshot") {
        const byBucket = new Map<string, { total: number; last: number }>();
        for (const c of charges) {
          const e = byBucket.get(c.bucket) ?? { total: 0, last: 0 };
          e.total = Math.round((e.total + c.usd) * 1e8) / 1e8;
          e.last = Math.max(e.last, c.nowMs);
          byBucket.set(c.bucket, e);
        }
        const chargeRows = [...byBucket].map(([bucket, e]) => ({
          bucket,
          chargesTotal: e.total,
          windowTotal: e.total,
          lastMs: e.last,
        }));
        return Response.json({ buckets: mergeLedger([], chargeRows) });
      }
      return new Response("not found", { status: 404 });
    },
  };
  return { namespace: { idFromName: (name: string) => name, get: () => stub }, stub };
}

/** The first recorded charge, or a thrown test error if none was recorded. */
function firstCharge(tracker: ReturnType<typeof fakeSpendTracker>): FakeCharge {
  const charge = tracker.stub.charges[0];
  if (charge === undefined) throw new Error("expected a recorded charge");
  return charge;
}

const ENV: Env = {
  OPENROUTER_API_KEY: KEY,
  JEV_MODEL: "typesafe/jev-1.13",
  ALLOWED_ORIGINS: `${APP_ORIGIN},${DEV_ORIGIN}`,
  // Never-throttles, so the throttle is inert unless a test installs its own.
  SPEND_TRACKER: fakeSpendTracker(false).namespace,
};

// Response shape per docs/jev-openrouter.md ("Response"): id, model, provider,
// answers keyed by our question ids (noul -> { type, noul }), usage.
const UPSTREAM_OK = {
  id: "gen-dec-test",
  model: "typesafe/jev-1.13-20260917",
  provider: "TypeSafe",
  answers: { favor: { type: "noul", noul: 0.81 } },
  usage: { input_tokens: 10, output_tokens: 2, cost: 0.00001 },
};

// Request shape per docs/jev-openrouter.md ("Request"): noul needs `instructions`.
const VALID_BODY = {
  state: { activity: "bowling" },
  questions: {
    favor: { type: "noul", instructions: "Do the stars favor this activity?" },
    category: {
      type: "choice",
      instructions: "Which body rules this?",
      criteria: { mars: "sports", venus: null },
    },
    intensity: {
      type: "score",
      instructions: "How intense?",
      criteria: ["Low", "Medium", "High"],
    },
  },
};
const ACTIVITY_TEXT = "bowling";

// The exact generic bodies the Worker may return. Asserting equality with these
// proves no upstream text, status or auth detail leaks into a response.
const GENERIC = {
  rateLimited: { error: { code: "rate_limited", message: "The oracle is busy. Try again shortly." } },
  unavailable: { error: { code: "unavailable", message: "The oracle is unavailable right now." } },
  upstream: { error: { code: "upstream_error", message: "The oracle could not answer. Try again." } },
};

// --- typed helpers ----------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function readJson(res: Response): Promise<unknown> {
  return res.clone().json();
}

async function errorCode(res: Response): Promise<string | undefined> {
  const body = await readJson(res);
  if (!isRecord(body) || !isRecord(body.error)) return undefined;
  const { code } = body.error;
  return typeof code === "string" ? code : undefined;
}

/** The parsed JSON body the Worker sent upstream on a given call. */
function sentBody(call: UpstreamCall | undefined): Record<string, unknown> {
  const parsed: unknown = JSON.parse(String(call?.init.body));
  if (!isRecord(parsed)) throw new Error("upstream body was not an object");
  return parsed;
}

interface UpstreamCall {
  url: string;
  init: RequestInit;
}

type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

function makeHandler(fetchImpl: FetchImpl, timeoutMs?: number) {
  const calls: UpstreamCall[] = [];
  const delays: number[] = [];
  const handler = createHandler({
    fetch: (url, init) => {
      calls.push({ url, init });
      return fetchImpl(url, init);
    },
    sleep: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return { handler, calls, delays };
}

/** Build a handler whose upstream fetch replays `responses` in order (last one repeats). */
function setup(responses: Array<(() => Response) | Error>) {
  let i = 0;
  return makeHandler(() => {
    const next = responses[Math.min(i, responses.length - 1)];
    i++;
    if (next === undefined) return Promise.reject(new Error("no mock response configured"));
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next());
  });
}

/** A factory, so each upstream attempt gets a fresh, unread Response. */
const jsonRes =
  (status: number, body: unknown = { message: "upstream detail" }) =>
  (): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(URL_, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** A POST whose body is a stream (no Content-Length unless given in `headers`). */
function postStream(
  stream: ReadableStream<Uint8Array>,
  headers: Record<string, string> = {},
): Request {
  // `duplex` is required by Node for stream bodies but is missing from the DOM RequestInit type.
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, ...headers },
    body: stream,
    duplex: "half",
  };
  return new Request(URL_, init);
}

function chunkedStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[i++];
      if (chunk === undefined) controller.close();
      else controller.enqueue(chunk);
    },
  });
}

function preflight(origin: string): Request {
  return new Request(URL_, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });
}

/** All header values of a response, for leak checks separate from the body. */
function headerText(res: Response): string {
  return [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
}

/** Assert the Worker's own hygiene headers are present on any response. */
function expectHygiene(res: Response): void {
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(res.headers.get("Vary")).toBe("Origin");
  expect(res.headers.has("Authorization")).toBe(false);
  expect(headerText(res)).not.toContain(KEY);
}

// --- tests ------------------------------------------------------------------

describe("happy path", () => {
  it("forwards to OpenRouter with the Worker's model and key, and returns the answer", async () => {
    const { handler, calls, delays } = setup([jsonRes(200, UPSTREAM_OK)]);
    const res = await handler(post(VALID_BODY), ENV);

    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual(UPSTREAM_OK);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expectHygiene(res);

    expect(calls).toHaveLength(1);
    expect(delays).toEqual([]);
    const call = calls[0];
    expect(call?.url).toBe(UPSTREAM_URL);
    expect(call?.init.method).toBe("POST");
    const headers = new Headers(call?.init.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${KEY}`);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(sentBody(call)).toEqual({ model: "typesafe/jev-1.13", ...VALID_BODY });
  });

  it("defaults the model when JEV_MODEL is unset", async () => {
    const { handler, calls } = setup([jsonRes(200, UPSTREAM_OK)]);
    await handler(post(VALID_BODY), { ...ENV, JEV_MODEL: undefined });
    expect(sentBody(calls[0]).model).toBe(DEFAULT_JEV_MODEL);
  });

  it("uses JEV_MODEL from the environment", async () => {
    const { handler, calls } = setup([jsonRes(200, UPSTREAM_OK)]);
    await handler(post(VALID_BODY), { ...ENV, JEV_MODEL: "~typesafe/jev-latest" });
    expect(sentBody(calls[0]).model).toBe("~typesafe/jev-latest");
  });

  it("accepts string and array state and a noul question with criteria", async () => {
    const { handler } = setup([jsonRes(200, UPSTREAM_OK)]);
    const noul = {
      favor: { type: "noul", instructions: "Q?", criteria: { true: "yes", false: "no" } },
    };
    for (const state of ["just text", ["a", "b"]]) {
      const res = await handler(post({ state, questions: noul }), ENV);
      expect(res.status).toBe(200);
    }
  });
});

describe("upstream 200 handling", () => {
  it("forwards only the whitelisted fields", async () => {
    const { handler } = setup([
      jsonRes(200, { ...UPSTREAM_OK, debug: "internal", request_headers: { x: "y" } }),
    ]);
    const res = await handler(post(VALID_BODY), ENV);
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual(UPSTREAM_OK);
  });

  it("forwards a minimal reply that has only answers", async () => {
    const { handler } = setup([jsonRes(200, { answers: UPSTREAM_OK.answers })]);
    const res = await handler(post(VALID_BODY), ENV);
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ answers: UPSTREAM_OK.answers });
  });

  it("maps HTTP 200 with an error body to a generic 502 with no upstream detail", async () => {
    const { handler, calls } = setup([
      jsonRes(200, { error: { code: 402, message: "Insufficient credits for account acct-123" } }),
    ]);
    const res = await handler(post(VALID_BODY), ENV);
    expect(res.status).toBe(502);
    expect(await readJson(res)).toEqual(GENERIC.upstream);
    expectHygiene(res);
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["no answers", { id: "x" }],
    ["answers is a string", { answers: "nope" }],
    ["answers is an array", { answers: [] }],
    ["answers is null", { answers: null }],
    ["a JSON array", []],
    ["a JSON string", "hello"],
  ])("maps a 200 with %s to a generic 502", async (_name, body) => {
    const { handler } = setup([jsonRes(200, body)]);
    const res = await handler(post(VALID_BODY), ENV);
    expect(res.status).toBe(502);
    expect(await readJson(res)).toEqual(GENERIC.upstream);
  });

  it("maps a non-JSON 200 body to a generic 502", async () => {
    const { handler } = setup([() => new Response("<html>oops</html>", { status: 200 })]);
    const res = await handler(post(VALID_BODY), ENV);
    expect(res.status).toBe(502);
    expect(await readJson(res)).toEqual(GENERIC.upstream);
  });
});

describe("missing key", () => {
  it.each([undefined, "", "   "])("returns a safe 500 for key %j and never calls upstream", async (key) => {
    const { handler, calls } = setup([jsonRes(200, UPSTREAM_OK)]);
    const res = await handler(post(VALID_BODY), { ...ENV, OPENROUTER_API_KEY: key });
    expect(res.status).toBe(500);
    expect(await readJson(res)).toEqual({
      error: { code: "server_misconfigured", message: "The oracle is not configured." },
    });
    expect(calls).toHaveLength(0);
  });
});

describe("upstream errors", () => {
  // Bodies that try to echo the key and auth details; none may reach the client.
  const leaky = (status: number) =>
    jsonRes(status, {
      error: { message: `Invalid key ${KEY}`, authorization: `Bearer ${KEY}` },
    });

  it("maps 401 to an exact generic 503 without retrying", async () => {
    const { handler, calls, delays } = setup([leaky(401)]);
    const res = await handler(post(VALID_BODY), ENV);
    expect(res.status).toBe(503);
    expect(await readJson(res)).toEqual(GENERIC.unavailable);
    expectHygiene(res);
    expect(calls).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  it("maps 402 (insufficient credits) to an exact generic 503 without retrying", async () => {
    const { handler, calls } = setup([jsonRes(402, { error: { message: "add credits" } })]);
    const res = await handler(post(VALID_BODY), ENV);
    expect(res.status).toBe(503);
    expect(await readJson(res)).toEqual(GENERIC.unavailable);
    expect(calls).toHaveLength(1);
  });

  it.each([
    [400, 502, GENERIC.upstream],
    [403, 503, GENERIC.unavailable],
    [404, 502, GENERIC.upstream],
    [413, 502, GENERIC.upstream],
  ])("does not retry upstream %i and returns exactly %i", async (upstreamStatus, expected, body) => {
    const { handler, calls, delays } = setup([jsonRes(upstreamStatus)]);
    const res = await handler(post(VALID_BODY), ENV);
    expect(res.status).toBe(expected);
    expect(await readJson(res)).toEqual(body);
    expect(calls).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  it("retries 429 with exponential backoff, then succeeds", async () => {
    const { handler, calls, delays } = setup([jsonRes(429), jsonRes(200, UPSTREAM_OK)]);
    const res = await handler(post(VALID_BODY), ENV);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(delays).toEqual([RETRY_BASE_DELAY_MS]);
  });

  it("gives up on persistent 429 after MAX_ATTEMPTS (3) and returns an exact 429", async () => {
    const { handler, calls, delays } = setup([leaky(429)]);
    const res = await handler(post(VALID_BODY), ENV);
    expect(MAX_ATTEMPTS).toBe(3);
    expect(res.status).toBe(429);
    expect(await readJson(res)).toEqual(GENERIC.rateLimited);
    expectHygiene(res);
    expect(calls).toHaveLength(3);
    expect(delays).toEqual([250, 500]);
  });

  it.each([500, 502, 503, 524, 529])("retries upstream %i then gives up with an exact generic 502", async (status) => {
    const { handler, calls, delays } = setup([leaky(status)]);
    const res = await handler(post(VALID_BODY), ENV);
    expect(res.status).toBe(502);
    expect(await readJson(res)).toEqual(GENERIC.upstream);
    expectHygiene(res);
    expect(calls).toHaveLength(3);
    expect(delays).toEqual([250, 500]);
  });

  it("recovers from a 529 followed by success", async () => {
    const { handler, calls } = setup([jsonRes(529), jsonRes(200, UPSTREAM_OK)]);
    const res = await handler(post(VALID_BODY), ENV);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("retries network errors and maps a persistent failure to an exact 502", async () => {
    const { handler, calls } = setup([new TypeError(`connect failed with ${KEY}`)]);
    const res = await handler(post(VALID_BODY), ENV);
    expect(res.status).toBe(502);
    expect(await readJson(res)).toEqual(GENERIC.upstream);
    expect(calls).toHaveLength(3);
  });

  it("gives every attempt an AbortSignal and retries a hung upstream up to the limit, then 502", async () => {
    const signals: AbortSignal[] = [];
    // A hung upstream: never resolves, rejects only when the Worker's timeout aborts it.
    const { handler, calls, delays } = makeHandler((_url, init) => {
      const { signal } = init;
      if (!(signal instanceof AbortSignal)) throw new Error("fetch was not given an AbortSignal");
      signals.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason));
      });
    }, 5);

    const res = await handler(post(VALID_BODY), ENV);
    expect(res.status).toBe(502);
    expect(await readJson(res)).toEqual(GENERIC.upstream);
    expect(calls).toHaveLength(MAX_ATTEMPTS);
    expect(delays).toEqual([250, 500]);
    expect(signals).toHaveLength(MAX_ATTEMPTS);
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(new Set(signals).size).toBe(MAX_ATTEMPTS);
  });

  it("uses a 10 s per-attempt timeout by default", () => {
    expect(UPSTREAM_TIMEOUT_MS).toBe(10_000);
  });
});

describe("unexpected failures", () => {
  it("returns a generic 500 with CORS headers when the body stream errors", async () => {
    const { handler, calls } = setup([jsonRes(200, UPSTREAM_OK)]);
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error(`stream exploded ${KEY}`);
      },
    });
    const res = await handler(postStream(stream), ENV);
    expect(res.status).toBe(500);
    expect(await readJson(res)).toEqual({
      error: { code: "internal_error", message: "Something went wrong." },
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(APP_ORIGIN);
    expectHygiene(res);
    expect(calls).toHaveLength(0);
  });

  it("returns a generic 500 with CORS headers when something throws between retries", async () => {
    const throwingSleep = createHandler({
      fetch: () => Promise.resolve(jsonRes(503)()),
      sleep: () => Promise.reject(new Error(`sleep exploded ${KEY}`)),
    });
    const res = await throwingSleep(post(VALID_BODY, { Origin: DEV_ORIGIN }), ENV);
    expect(res.status).toBe(500);
    expect(await readJson(res)).toEqual({
      error: { code: "internal_error", message: "Something went wrong." },
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(DEV_ORIGIN);
    expectHygiene(res);
  });
});

describe("input validation", () => {
  it("rejects malformed JSON with 400 and does not call upstream", async () => {
    const { handler, calls } = setup([jsonRes(200, UPSTREAM_OK)]);
    const res = await handler(post("{not json"), ENV);
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("invalid_json");
    expect(calls).toHaveLength(0);
  });

  describe("body size limit", () => {
    const encoder = new TextEncoder();
    const questions = { q: { type: "noul", instructions: "Q?" } };

    /** Valid JSON whose UTF-8 length is exactly `bytes` (ASCII only). */
    function bodyOfSize(bytes: number): string {
      const base = JSON.stringify({ state: "", questions }).length;
      const text = JSON.stringify({ state: "x".repeat(bytes - base), questions });
      expect(encoder.encode(text).byteLength).toBe(bytes);
      return text;
    }

    it("takes the Content-Length shortcut without reading the body", async () => {
      const { handler, calls } = setup([jsonRes(200, UPSTREAM_OK)]);
      let pulled = false;
      // highWaterMark 0: the stream is pulled only when a consumer actually reads it.
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulled = true;
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
      const req = postStream(stream, { "Content-Length": String(MAX_BODY_BYTES + 1) });
      // Prove the runtime kept the header, so this really exercises that branch.
      expect(req.headers.get("Content-Length")).toBe(String(MAX_BODY_BYTES + 1));

      const res = await handler(req, ENV);
      expect(res.status).toBe(413);
      expect(await errorCode(res)).toBe("payload_too_large");
      expect(pulled).toBe(false);
      expect(calls).toHaveLength(0);
    });

    it("rejects a single-chunk streamed body over the limit (no Content-Length)", async () => {
      const { handler, calls } = setup([jsonRes(200, UPSTREAM_OK)]);
      const req = postStream(chunkedStream([encoder.encode(bodyOfSize(MAX_BODY_BYTES + 1))]));
      expect(req.headers.get("Content-Length")).toBeNull();
      const res = await handler(req, ENV);
      expect(res.status).toBe(413);
      expect(calls).toHaveLength(0);
    });

    it("rejects a multi-chunk streamed body that crosses the limit mid-stream", async () => {
      const { handler, calls } = setup([jsonRes(200, UPSTREAM_OK)]);
      const chunk = encoder.encode("x".repeat(8 * 1024));
      const req = postStream(chunkedStream([chunk, chunk, chunk, chunk, chunk]));
      expect(req.headers.get("Content-Length")).toBeNull();
      const res = await handler(req, ENV);
      expect(res.status).toBe(413);
      expect(await errorCode(res)).toBe("payload_too_large");
      expect(calls).toHaveLength(0);
    });

    it("accepts a body of exactly MAX_BODY_BYTES (string and multi-chunk stream)", async () => {
      const text = bodyOfSize(MAX_BODY_BYTES);
      const { handler, calls } = setup([jsonRes(200, UPSTREAM_OK)]);

      const asString = await handler(post(text), ENV);
      expect(asString.status).toBe(200);

      const bytes = encoder.encode(text);
      const third = Math.floor(bytes.length / 3);
      const asStream = await handler(
        postStream(chunkedStream([bytes.slice(0, third), bytes.slice(third, 2 * third), bytes.slice(2 * third)])),
        ENV,
      );
      expect(asStream.status).toBe(200);
      expect(calls).toHaveLength(2);
    });

    it("accepts Content-Length equal to the limit and rejects one byte more as a string body", async () => {
      const { handler } = setup([jsonRes(200, UPSTREAM_OK)]);
      const atLimit = await handler(post(bodyOfSize(MAX_BODY_BYTES), { "Content-Length": String(MAX_BODY_BYTES) }), ENV);
      expect(atLimit.status).toBe(200);
      const over = await handler(post(bodyOfSize(MAX_BODY_BYTES + 1)), ENV);
      expect(over.status).toBe(413);
    });
  });

  describe("content type", () => {
    it.each([
      "application/json",
      "application/json; charset=utf-8",
      "Application/JSON;charset=UTF-8",
    ])("accepts %s", async (contentType) => {
      const { handler } = setup([jsonRes(200, UPSTREAM_OK)]);
      const res = await handler(post(VALID_BODY, { "Content-Type": contentType }), ENV);
      expect(res.status).toBe(200);
    });

    it.each([
      "text/plain",
      "application/jsonx",
      "application/json-patch+json",
      "application/json; boundary=x",
      "application/json; charset=utf-8; extra=1",
      "text/plain; application/json",
      "",
    ])("rejects %j with 415", async (contentType) => {
      const { handler, calls } = setup([jsonRes(200, UPSTREAM_OK)]);
      const res = await handler(post(VALID_BODY, { "Content-Type": contentType }), ENV);
      expect(res.status).toBe(415);
      expect(await errorCode(res)).toBe("unsupported_media_type");
      expect(calls).toHaveLength(0);
    });
  });

  const invalidBodies: Array<[string, unknown]> = [
    ["a JSON array", []],
    ["null", null],
    ["a number", 5],
    ["missing questions", { state: "s" }],
    ["missing state", { questions: VALID_BODY.questions }],
    ["numeric state", { state: 5, questions: VALID_BODY.questions }],
    ["client-chosen model", { ...VALID_BODY, model: "openai/gpt-5" }],
    ["empty questions", { state: "s", questions: {} }],
    ["questions as array", { state: "s", questions: [] }],
    [
      "too many questions",
      {
        state: "s",
        questions: Object.fromEntries(
          Array.from({ length: 9 }, (_, n) => [`q${n}`, { type: "noul", instructions: "Q?" }]),
        ),
      },
    ],
    ["unknown question type", { state: "s", questions: { q: { type: "text", instructions: "Q?" } } }],
    ["question missing instructions", { state: "s", questions: { q: { type: "noul" } } }],
    [
      "question with extra field",
      { state: "s", questions: { q: { type: "noul", instructions: "Q?", model: "x" } } },
    ],
    [
      "noul criteria with bad key",
      { state: "s", questions: { q: { type: "noul", instructions: "Q?", criteria: { maybe: "x" } } } },
    ],
    ["choice without criteria", { state: "s", questions: { q: { type: "choice", instructions: "Q?" } } }],
    [
      "choice with empty criteria",
      { state: "s", questions: { q: { type: "choice", instructions: "Q?", criteria: {} } } },
    ],
    [
      "choice with numeric description",
      { state: "s", questions: { q: { type: "choice", instructions: "Q?", criteria: { a: 1 } } } },
    ],
    [
      "score with one level",
      { state: "s", questions: { q: { type: "score", instructions: "Q?", criteria: ["only"] } } },
    ],
    [
      "score with eleven levels",
      {
        state: "s",
        questions: {
          q: {
            type: "score",
            instructions: "Q?",
            criteria: Array.from({ length: 11 }, (_, n) => `l${n}`),
          },
        },
      },
    ],
    [
      "score with non-string level",
      { state: "s", questions: { q: { type: "score", instructions: "Q?", criteria: ["a", 2] } } },
    ],
  ];

  it.each(invalidBodies)("rejects %s with 400", async (_name, body) => {
    const { handler, calls } = setup([jsonRes(200, UPSTREAM_OK)]);
    const res = await handler(post(body), ENV);
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("invalid_request");
    expect(calls).toHaveLength(0);
  });

  // Raw JSON text: an object literal with `__proto__` would set the prototype
  // instead of creating the own key that JSON.parse produces.
  const reservedBodies: Array<[string, string]> = [
    ["a __proto__ question id", '{"state":"s","questions":{"__proto__":{"type":"noul","instructions":"Q?"}}}'],
    ["a constructor question id", '{"state":"s","questions":{"constructor":{"type":"noul","instructions":"Q?"}}}'],
    ["a prototype question id", '{"state":"s","questions":{"prototype":{"type":"noul","instructions":"Q?"}}}'],
    [
      "a __proto__ choice option",
      '{"state":"s","questions":{"q":{"type":"choice","instructions":"Q?","criteria":{"__proto__":"x","mars":"y"}}}}',
    ],
    [
      "a constructor choice option",
      '{"state":"s","questions":{"q":{"type":"choice","instructions":"Q?","criteria":{"constructor":null,"mars":"y"}}}}',
    ],
    [
      "a prototype choice option",
      '{"state":"s","questions":{"q":{"type":"choice","instructions":"Q?","criteria":{"prototype":"x","mars":"y"}}}}',
    ],
  ];

  it.each(reservedBodies)("rejects %s with 400 invalid_request", async (_name, raw) => {
    const { handler, calls } = setup([jsonRes(200, UPSTREAM_OK)]);
    const res = await handler(post(raw), ENV);
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("invalid_request");
    expect(calls).toHaveLength(0);
  });
});

describe("CORS and routing", () => {
  it("rejects a non-allowlisted origin with 403, no CORS headers, and no upstream call", async () => {
    const { handler, calls } = setup([jsonRes(200, UPSTREAM_OK)]);
    const res = await handler(post(VALID_BODY, { Origin: "https://evil.example" }), ENV);
    expect(res.status).toBe(403);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("Vary")).toBe("Origin");
    expect(calls).toHaveLength(0);
  });

  it("rejects a preflight from a non-allowlisted origin", async () => {
    const { handler } = setup([]);
    const res = await handler(preflight("https://evil.example"), ENV);
    expect(res.status).toBe(403);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("rejects everything from browsers when ALLOWED_ORIGINS is unset", async () => {
    const { handler } = setup([jsonRes(200, UPSTREAM_OK)]);
    const res = await handler(post(VALID_BODY), { ...ENV, ALLOWED_ORIGINS: undefined });
    expect(res.status).toBe(403);
  });

  // Matching is exact string equality against the allowlist. Every value below
  // fails closed. The only thing treated as "no origin" is an ABSENT Origin
  // header (see the test after this one); an empty `Origin:` header is present
  // and therefore checked, and rejected.
  it.each([
    ["the literal null origin", "null"],
    ["different case", "HTTPS://DGABRIEL.GITHUB.IO"],
    ["a trailing slash", "https://dgabriel.github.io/"],
    ["a suffix attack", "https://dgabriel.github.io.evil.example"],
    ["a prefix attack", "https://evil.dgabriel.github.io"],
    ["the wrong scheme", "http://dgabriel.github.io"],
    ["the wrong port", "http://localhost:5174"],
    ["an empty header", ""],
  ])("fails closed on %s", async (_name, origin) => {
    const { handler, calls } = setup([jsonRes(200, UPSTREAM_OK)]);
    const req = post(VALID_BODY, { Origin: origin });
    expect(req.headers.get("Origin")).toBe(origin); // the handler really sees this value

    const res = await handler(req, ENV);
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("origin_not_allowed");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(calls).toHaveLength(0);

    const pre = await handler(preflight(origin), ENV);
    expect(pre.status).toBe(403);
    expect(pre.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it.each([APP_ORIGIN, DEV_ORIGIN])("answers a preflight from %s", async (origin) => {
    const { handler, calls } = setup([]);
    const res = await handler(preflight(origin), ENV);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe("POST, OPTIONS");
    expect(res.headers.get("Access-Control-Allow-Headers")).toBe("Content-Type");
    expect(res.headers.get("Vary")).toBe("Origin");
    expect(calls).toHaveLength(0);
  });

  it("echoes the allowed origin (never *) on success and on errors", async () => {
    const { handler } = setup([jsonRes(200, UPSTREAM_OK)]);
    const good = await handler(post(VALID_BODY, { Origin: DEV_ORIGIN }), ENV);
    expect(good.headers.get("Access-Control-Allow-Origin")).toBe(DEV_ORIGIN);
    expect(good.headers.get("Vary")).toBe("Origin");

    const bad = await handler(post("{nope", { Origin: DEV_ORIGIN }), ENV);
    expect(bad.status).toBe(400);
    expect(bad.headers.get("Access-Control-Allow-Origin")).toBe(DEV_ORIGIN);
  });

  it("serves a request with an ABSENT Origin header, without CORS headers", async () => {
    const { handler } = setup([jsonRes(200, UPSTREAM_OK)]);
    const req = new Request(URL_, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });
    expect(req.headers.has("Origin")).toBe(false);
    const res = await handler(req, ENV);
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("returns 404 for other paths and 405 for other methods", async () => {
    const { handler } = setup([]);
    const notFound = await handler(new Request("https://worker.test/other"), ENV);
    expect(notFound.status).toBe(404);
    const wrongMethod = await handler(
      new Request(URL_, { method: "GET", headers: { Origin: APP_ORIGIN } }),
      ENV,
    );
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("Allow")).toBe("POST, OPTIONS");
  });
});

describe("secrecy", () => {
  const leaky = (status: number) =>
    jsonRes(status, {
      error: { message: `Invalid key ${KEY}`, authorization: `Bearer ${KEY}` },
    });

  interface Scenario {
    name: string;
    /** True only when the request body sent in this scenario contains ACTIVITY_TEXT. */
    sentActivity: boolean;
    run: () => Promise<Response>;
  }

  const scenarios: Scenario[] = [
    { name: "ok", sentActivity: true, run: () => setup([jsonRes(200, UPSTREAM_OK)]).handler(post(VALID_BODY), ENV) },
    { name: "401", sentActivity: true, run: () => setup([leaky(401)]).handler(post(VALID_BODY), ENV) },
    { name: "402", sentActivity: true, run: () => setup([leaky(402)]).handler(post(VALID_BODY), ENV) },
    { name: "429", sentActivity: true, run: () => setup([leaky(429)]).handler(post(VALID_BODY), ENV) },
    { name: "500", sentActivity: true, run: () => setup([leaky(500)]).handler(post(VALID_BODY), ENV) },
    { name: "200 with error", sentActivity: true, run: () => setup([leaky(200)]).handler(post(VALID_BODY), ENV) },
    { name: "network", sentActivity: true, run: () => setup([new Error(KEY)]).handler(post(VALID_BODY), ENV) },
    {
      name: "bad json",
      sentActivity: true,
      run: () => setup([]).handler(post(`{"state":"${ACTIVITY_TEXT}"`), ENV),
    },
    {
      name: "bad shape",
      sentActivity: true,
      run: () => setup([]).handler(post({ state: ACTIVITY_TEXT, questions: [] }), ENV),
    },
    {
      name: "bad origin",
      sentActivity: true,
      run: () => setup([]).handler(post(VALID_BODY, { Origin: "https://x.example" }), ENV),
    },
    {
      name: "bad content type",
      sentActivity: true,
      run: () => setup([]).handler(post(VALID_BODY, { "Content-Type": "text/plain" }), ENV),
    },
    {
      name: "missing key",
      sentActivity: true,
      run: () => setup([]).handler(post(VALID_BODY), { ...ENV, OPENROUTER_API_KEY: undefined }),
    },
    { name: "preflight", sentActivity: false, run: () => setup([]).handler(preflight(APP_ORIGIN), ENV) },
  ];

  it("has scenarios that really carry the activity text", () => {
    expect(JSON.stringify(VALID_BODY)).toContain(ACTIVITY_TEXT);
  });

  it.each(scenarios)("scenario $name: the key never appears in the body or headers", async ({ run }) => {
    const res = await run();
    expect(await res.clone().text()).not.toContain(KEY);
    expect(headerText(res)).not.toContain(KEY);
    expect(headerText(res).toLowerCase()).not.toContain("bearer");
  });

  it.each(scenarios.filter((s) => s.sentActivity))(
    "scenario $name: the activity text is not echoed back",
    async ({ run }) => {
      const res = await run();
      expect((await res.clone().text()).toLowerCase()).not.toContain(ACTIVITY_TEXT);
      expect(headerText(res).toLowerCase()).not.toContain(ACTIVITY_TEXT);
    },
  );
});

// ---------------------------------------------------------------------------
// Spend throttle (POST /api/decide): check-then-charge against the ledger
// ---------------------------------------------------------------------------

describe("spend throttle", () => {
  const IP = "203.0.113.7";

  const throttledEnv = (
    namespace: SpendTrackerNamespace,
    overrides: Partial<Env> = {},
  ): Env => ({
    ...ENV,
    SPEND_TRACKER: namespace,
    // One mocked 0.00001 call fits; the next check sees spend >= cap.
    SPEND_CAP_USD_PER_IP: "0.00001",
    ...overrides,
  });

  it("charges the caller's bucket the exact usage.cost after a success", async () => {
    const tracker = fakeSpendTracker();
    const { handler } = setup([jsonRes(200, UPSTREAM_OK)]); // usage.cost = 0.00001
    const res = await handler(
      post(VALID_BODY, { "CF-Connecting-IP": IP }),
      throttledEnv(tracker.namespace),
    );
    expect(res.status).toBe(200);
    expect(tracker.stub.charges).toHaveLength(1);
    expect(firstCharge(tracker).bucket).toBe(IP);
    expect(firstCharge(tracker).usd).toBe(0.00001);
  });

  it("429s at the cap without touching upstream, with the throttle-specific message", async () => {
    const tracker = fakeSpendTracker();
    const { handler, calls } = setup([jsonRes(200, UPSTREAM_OK)]);
    const env = throttledEnv(tracker.namespace);
    const first = await handler(post(VALID_BODY, { "CF-Connecting-IP": IP }), env);
    expect(first.status).toBe(200);
    const second = await handler(post(VALID_BODY, { "CF-Connecting-IP": IP }), env);
    expect(second.status).toBe(429);
    expect(await readJson(second)).toEqual({
      error: { code: "rate_limited", message: THROTTLED_MESSAGE },
    });
    expect(await second.clone().text()).not.toContain(KEY);
    expect(calls).toHaveLength(1); // the second request never reached upstream
  });

  it("buckets IPv6 by /64: two addresses in one prefix share one budget", async () => {
    const tracker = fakeSpendTracker();
    const { handler } = setup([jsonRes(200, UPSTREAM_OK)]);
    const env = throttledEnv(tracker.namespace);
    const first = await handler(
      post(VALID_BODY, { "CF-Connecting-IP": "2001:db8:1234:abcd::1" }),
      env,
    );
    expect(first.status).toBe(200);
    expect(firstCharge(tracker).bucket).toBe("2001:0db8:1234:abcd::/64");
    const second = await handler(
      post(VALID_BODY, { "CF-Connecting-IP": "2001:db8:1234:abcd:ffff::9" }),
      env,
    );
    expect(second.status).toBe(429);
  });

  it("exempt buckets skip the check but are still charged", async () => {
    const tracker = fakeSpendTracker();
    const { handler, calls } = setup([jsonRes(200, UPSTREAM_OK)]);
    const env = throttledEnv(tracker.namespace, {
      THROTTLE_EXEMPT_IPS: IP,
      SPEND_CAP_USD_PER_IP: "0.000005", // one call would already exceed it
    });
    for (let i = 0; i < 3; i++) {
      const res = await handler(post(VALID_BODY, { "CF-Connecting-IP": IP }), env);
      expect(res.status).toBe(200);
    }
    expect(calls).toHaveLength(3);
    expect(tracker.stub.charges).toHaveLength(3); // metered even though uncapped
  });

  it("missing CF-Connecting-IP lands in the capped 'unknown' bucket", async () => {
    const tracker = fakeSpendTracker();
    const { handler } = setup([jsonRes(200, UPSTREAM_OK)]);
    const env = throttledEnv(tracker.namespace);
    const req = new Request(URL_, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: APP_ORIGIN },
      body: JSON.stringify(VALID_BODY),
    });
    const res = await handler(req, env);
    expect(res.status).toBe(200);
    expect(firstCharge(tracker).bucket).toBe("unknown");
  });

  it("a success without a numeric usage.cost is charged the fallback amount", async () => {
    const tracker = fakeSpendTracker();
    const noCost = { ...UPSTREAM_OK, usage: { input_tokens: 10, output_tokens: 2 } };
    const { handler } = setup([jsonRes(200, noCost)]);
    const res = await handler(
      post(VALID_BODY, { "CF-Connecting-IP": IP }),
      throttledEnv(tracker.namespace),
    );
    expect(res.status).toBe(200);
    expect(firstCharge(tracker).usd).toBe(FALLBACK_CHARGE_USD);
  });

  it("an upstream failure charges nothing", async () => {
    const tracker = fakeSpendTracker();
    const { handler, calls } = setup([jsonRes(500)]);
    const res = await handler(
      post(VALID_BODY, { "CF-Connecting-IP": IP }),
      throttledEnv(tracker.namespace),
    );
    expect(res.status).toBe(502);
    expect(calls).toHaveLength(MAX_ATTEMPTS); // retry behavior unchanged
    expect(tracker.stub.charges).toHaveLength(0);
  });

  it("fails closed (503, no upstream call) when the ledger errors", async () => {
    const tracker = fakeSpendTracker();
    tracker.stub.breakChecks();
    const { handler, calls } = setup([jsonRes(200, UPSTREAM_OK)]);
    const res = await handler(
      post(VALID_BODY, { "CF-Connecting-IP": IP }),
      throttledEnv(tracker.namespace),
    );
    expect(res.status).toBe(503);
    expect(await errorCode(res)).toBe("unavailable");
    expect(calls).toHaveLength(0);
  });

  it("fails closed when the binding or the cap is misconfigured", async () => {
    const { handler, calls } = setup([jsonRes(200, UPSTREAM_OK)]);
    const noBinding = await handler(post(VALID_BODY), { ...ENV, SPEND_TRACKER: undefined });
    expect(noBinding.status).toBe(503);
    const badCap = await handler(
      post(VALID_BODY),
      throttledEnv(fakeSpendTracker().namespace, { SPEND_CAP_USD_PER_IP: "banana" }),
    );
    expect(badCap.status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it("charges via waitUntil when an execution context is present", async () => {
    const tracker = fakeSpendTracker();
    const { handler } = setup([jsonRes(200, UPSTREAM_OK)]);
    let awaited: Promise<unknown> | undefined;
    const ctx = {
      waitUntil: (p: Promise<unknown>) => {
        awaited = p;
      },
    };
    const res = await handler(
      post(VALID_BODY, { "CF-Connecting-IP": IP }),
      throttledEnv(tracker.namespace),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(awaited).toBeDefined();
    await awaited;
    expect(tracker.stub.charges).toHaveLength(1);
  });

  it("a meter failure after a success still returns the verdict", async () => {
    const tracker = fakeSpendTracker();
    const brokenCharge: FakeTrackerStub = {
      ...tracker.stub,
      fetch: (request: Request) =>
        new URL(request.url).pathname === "/charge"
          ? Promise.resolve(new Response("down", { status: 503 }))
          : tracker.stub.fetch(request),
    };
    const namespace: SpendTrackerNamespace = { idFromName: (n: string) => n, get: () => brokenCharge };
    const { handler } = setup([jsonRes(200, UPSTREAM_OK)]);
    const res = await handler(
      post(VALID_BODY, { "CF-Connecting-IP": IP }),
      throttledEnv(namespace),
    );
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET /api/admin/spend
// ---------------------------------------------------------------------------

describe("admin spend snapshot", () => {
  interface SnapshotBody {
    window_days: number;
    cap_usd: number | null;
    generated_at: string;
    total_usd: number;
    buckets: Array<{
      bucket: string;
      spend_7d_usd: number;
      total_usd: number;
      last_charge_at: string | null;
    }>;
  }

  const getAdmin = (headers: Record<string, string> = {}) =>
    new Request(ADMIN_URL, { method: "GET", headers: { Origin: APP_ORIGIN, ...headers } });

  it("lists buckets by 7-day spend, omits exempt rows, and counts them in the total", async () => {
    const tracker = fakeSpendTracker();
    tracker.stub.seed("203.0.113.7", 0.00001, 1760000000000);
    tracker.stub.seed("203.0.113.8", 0.00002, 1760000000001);
    tracker.stub.seed("10.9.8.7", 0.007, 1760000000002);
    const env: Env = {
      ...ENV,
      SPEND_TRACKER: tracker.namespace,
      THROTTLE_EXEMPT_IPS: "10.9.8.7",
    };
    const { handler } = setup([]);
    const res = await handler(getAdmin(), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(APP_ORIGIN);
    const body = (await readJson(res)) as SnapshotBody;
    expect(body.window_days).toBe(7);
    expect(body.cap_usd).toBe(0.01);
    expect(typeof body.generated_at).toBe("string");
    expect(body.total_usd).toBe(0.00703); // includes the exempt bucket's 0.007
    expect(body.buckets).toEqual([
      {
        bucket: "203.0.113.8",
        spend_7d_usd: 0.00002,
        total_usd: 0.00002,
        last_charge_at: new Date(1760000000001).toISOString(),
      },
      {
        bucket: "203.0.113.7",
        spend_7d_usd: 0.00001,
        total_usd: 0.00001,
        last_charge_at: new Date(1760000000000).toISOString(),
      },
    ]);
    expect(JSON.stringify(body)).not.toContain("10.9.8.7"); // exempt IP never published
  });

  it("serves a request with no Origin header (curl) without CORS headers", async () => {
    const tracker = fakeSpendTracker();
    tracker.stub.seed("203.0.113.7", 0.00001, 1760000000000);
    const { handler } = setup([]);
    const res = await handler(
      new Request(ADMIN_URL, { method: "GET" }),
      { ...ENV, SPEND_TRACKER: tracker.namespace },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("rejects a non-allowlisted Origin and non-GET methods, preflights like decide", async () => {
    const { handler } = setup([]);
    const evil = await handler(new Request(ADMIN_URL, { method: "GET", headers: { Origin: "https://evil.example" } }), ENV);
    expect(evil.status).toBe(403);
    const posted = await handler(new Request(ADMIN_URL, { method: "POST", headers: { Origin: APP_ORIGIN } }), ENV);
    expect(posted.status).toBe(405);
    expect(posted.headers.get("Allow")).toBe("GET, OPTIONS");
    const preflight = await handler(new Request(ADMIN_URL, { method: "OPTIONS", headers: { Origin: APP_ORIGIN } }), ENV);
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Methods")).toBe("GET, OPTIONS");
  });

  it("is 503 (not a leak) when the binding is missing", async () => {
    const { handler } = setup([]);
    const res = await handler(getAdmin(), { ...ENV, SPEND_TRACKER: undefined });
    expect(res.status).toBe(503);
    expect(await readJson(res)).toEqual(GENERIC.unavailable);
  });

  it("does not touch upstream and contains no key material", async () => {
    const tracker = fakeSpendTracker();
    tracker.stub.seed("203.0.113.7", 0.00001, 1760000000000);
    const { handler, calls } = setup([]);
    const res = await handler(getAdmin(), { ...ENV, SPEND_TRACKER: tracker.namespace });
    expect(calls).toHaveLength(0);
    expect(await res.clone().text()).not.toContain(KEY);
  });
});
