# Jev via OpenRouter — how Cosmic JEV calls it

The first half of this file walks through the real calls Cosmic JEV makes,
with request and response bodies captured from the live system. The second
half is the verified API reference those calls are built on.

## How a question flows

![Sequence diagram: browser, Worker, OpenRouter. Call 1 classify and Call 2 verdict are each one round trip; route() runs in the browser between them.](img/call-sequence.svg)

One question is at most two calls to Jev, and each call is one HTTP round
trip: browser → Worker → OpenRouter → Worker → browser.

1. **Locally, before any network:** `sky.ts` and `natal.ts` compute today's
   transits and the asker's natal chart with `astronomy-engine`.
2. **Call 1, classify.** The `state` is only the activity text. Three
   questions are batched: which planet rules it (`choice`), how sensitive it
   is (`choice`), and whether it is too vague (`noul`).
3. **`route()`, in the browser.** Recusal and "too vague" stop here, after
   one call (see [Routing between the calls](#routing-between-the-calls)).
4. **Call 2, verdict.** The `state` is the chart facts relevant to the
   ruling planet. Two questions are batched: does the sky favor this (`noul`),
   and how intense is it (`score`).
5. **Locally, after:** `explain.ts` fills a fixed template from the typed
   answers. Jev never writes any text.

The browser never sees the OpenRouter key and never picks the model. It sends
only `{ state, questions }` to the Worker's `POST /api/decide`. The Worker
adds `model` and the `Authorization` header, calls OpenRouter, and passes back
only the whitelisted fields of the reply.

### What the Worker checks on every call

![Worker gates, top to bottom: origin allowlist, method/content type/size, body shape, per-IP spend cap, then attach model and key and call upstream, whitelist the reply, charge the cost.](img/worker-gates.svg)

The key is attached at step 5, only after every cheaper check has passed.
Details of the spend cap are in
[Spend throttle and admin endpoint](#spend-throttle-and-admin-endpoint-worker-side).

## Real calls, captured

These bodies are real, not hand-written. They were captured on 2026-10-07 by
running the app's own `askOracle()` (`src/oracle.ts`) with `JevOracle`
against the deployed Worker, using a sample natal chart (born 1990-07-14, no
birth time or location). The raw capture, including the
bowling/recusal/vague runs summarized below, is in
[`examples/jev-calls-2026-10-07.json`](examples/jev-calls-2026-10-07.json).
Key order inside `probabilities` is whatever Jev returned.

The worked example is **"Should I work late tonight"**, the one capture that
exercises everything: a retrograde ruling planet, a real aspect to the natal
chart, and a vague score just under the threshold.

### Call 1: classify

Browser → Worker, `POST https://cosmic-oracle-worker.cosmic-oracle.workers.dev/api/decide`
(`src/oracle-jev.ts` `classifyRequestBody`):

```json
{
  "state": "Should I work late tonight",
  "questions": {
    "category": {
      "type": "choice",
      "instructions": "Which celestial body rules this activity?",
      "criteria": {
        "Mars": "Sports, exercise, competition, confrontation, bold new starts.",
        "Venus": "Romance, dating, art, beauty, fashion, socializing, treats.",
        "Mercury": "Communication, writing, emails, short trips, tech, contracts.",
        "Jupiter": "Learning, long travel, games of chance, celebrations.",
        "Saturn": "Work, chores, commitments, long-term planning.",
        "Moon": "Home, cooking, family, rest, self-care.",
        "Sun": "Performance, creative self-expression, being the center of attention."
      }
    },
    "sensitivity": {
      "type": "choice",
      "instructions": "Classify this activity's sensitivity. Check for violence or harm to a person or animal (including self-harm) first -- that always wins over every other category. Otherwise pick whichever single category best applies, or 'none' if nothing applies.",
      "criteria": {
        "violence_person": "Violence, harm, or aggression directed at a person or animal -- including the asker harming themselves (self-harm, suicide, or wanting to end their own life), and eating an animal that isn't ordinary food: a pet or companion animal (cat, dog, rabbit, hamster, horse), a protected or endangered animal (dolphin, whale, panda, ape), or a person. Eating ordinary food animals (chicken, fish, beef, pork, lamb, seafood) is NOT harm. Always pick this over health/safety/legal if it applies.",
        "safety": "A decision about physical safety or risk of injury, not otherwise about violence toward a person, animal, or object.",
        "legal": "A decision with legal consequences: lawsuits, contracts with legal weight, breaking the law, legal advice.",
        "health": "A decision about physical or mental health, medication, medical treatment, surgery, or diagnosis -- not self-harm.",
        "money": "A significant financial decision: investing, borrowing, a loan or mortgage, savings, or debt.",
        "relationship_ending": "A decision about ending a romantic relationship or marriage (breakup, divorce).",
        "job_quitting": "A decision about quitting or resigning from a job.",
        "violence_object": "Violence, force, or destruction directed only at an inanimate object or thing (e.g. smashing a printer) -- never at a person or animal, and not self-harm.",
        "none": "None of the above: an ordinary activity with no special real-life-consequence or safety concern, including eating ordinary food such as chicken, fish, beef, pork, or lamb."
      }
    },
    "vague": {
      "type": "noul",
      "instructions": "Is this activity description too vague to categorize?"
    }
  }
}
```

Worker → OpenRouter, `POST https://openrouter.ai/api/v1/systemone`: the same
body with one field added, plus the key header (`worker/handler.ts`):

```http
Authorization: Bearer <OPENROUTER_API_KEY>
Content-Type: application/json

{ "model": "typesafe/jev-1.13", "state": …, "questions": … }
```

Reply, Worker → browser (388 ms round trip, measured in the browser):

```json
{
  "id": "gen-dec-1791389938-p5CRq7OQKy4bWwB5daLi",
  "model": "typesafe/jev-1.13-20260917",
  "provider": "TypeSafe",
  "answers": {
    "category": {
      "type": "choice",
      "choice": "Saturn",
      "probabilities": { "Saturn": 0.98, "Moon": 0.02, "Jupiter": 0, "Venus": 0, "Mars": 0, "Sun": 0, "Mercury": 0 },
      "confidence": 0.98
    },
    "sensitivity": {
      "type": "choice",
      "choice": "none",
      "probabilities": { "none": 0.68, "job_quitting": 0, "violence_person": 0, "health": 0.29, "money": 0.01, "violence_object": 0, "relationship_ending": 0, "safety": 0.02, "legal": 0 },
      "confidence": 0.64
    },
    "vague": { "type": "noul", "noul": 0.69 }
  },
  "usage": { "input_tokens": 957, "output_tokens": 180, "cost": 0.000040194 }
}
```

`JevOracle` reads only `category.choice`, `sensitivity.choice` and
`vague.noul`. Note that `health` drew 0.29 and `vague` is 0.69, so this
question came close on two axes and still went through.

### Routing between the calls

![route() decision: violence_person, safety or legal → recusal; else vague ≥ 0.75 → ask for detail; else Call 2. Annotated with the three real examples.](img/routing.svg)

`route()` (`src/oracle.ts`) is a pure function shared by `JevOracle` and
`StubOracle`. For "work late", `sensitivity` is `none` and `vague` is
0.69 < 0.75, so it proceeds to Call 2 with `category: "Saturn"`. The
browser then filters its own aspect list down to aspects from transiting
Saturn.

### Call 2: verdict

Browser → Worker (`verdictRequestBody`). Everything in `state` came from
`astronomy-engine`, computed in the browser; nothing about the asker except
these derived facts and the activity text is sent:

```json
{
  "state": {
    "category": "Saturn",
    "rulingBodyTransit": {
      "body": "Saturn",
      "longitude": 11.050763605494124,
      "sign": "Aries",
      "degreeInSign": 11.050763605494124,
      "retrograde": true
    },
    "aspects": [
      { "transit": "Saturn", "natal": "Moon", "aspect": "conjunction", "orb": 1.7023610050000784, "applying": true }
    ],
    "moonPhase": "waning crescent",
    "activityText": "Should I work late tonight"
  },
  "questions": {
    "favor": {
      "type": "noul",
      "instructions": "Do the stars favor this activity for this person today?"
    },
    "intensity": {
      "type": "score",
      "instructions": "How intense are today's cosmic influences on this activity?",
      "criteria": [
        "Barely a cosmic murmur",
        "A mild celestial nudge",
        "A noticeable planetary pull",
        "A strong astral push",
        "An overwhelming cosmic surge"
      ]
    }
  }
}
```

Reply (338 ms round trip):

```json
{
  "id": "gen-dec-1791389939-8zLvHni0iVSTx2Vp0zdh",
  "model": "typesafe/jev-1.13-20260917",
  "provider": "TypeSafe",
  "answers": {
    "favor": { "type": "noul", "noul": 0.27 },
    "intensity": {
      "type": "score",
      "score": 2.69,
      "legend": {
        "0": "Barely a cosmic murmur",
        "1": "A mild celestial nudge",
        "2": "A noticeable planetary pull",
        "3": "A strong astral push",
        "4": "An overwhelming cosmic surge"
      },
      "probabilities": { "0": 0, "1": 0.01, "2": 0.28, "3": 0.7, "4": 0.01 },
      "confidence": 0.74
    }
  },
  "usage": { "input_tokens": 543, "output_tokens": 35, "cost": 0.000022806 }
}
```

`JevOracle` turns this into `{ favor: 0.27, intensity: 0.6725 }`
(`2.69 / (5 − 1)`). `explain.ts` then fills its template:

> Should I work late tonight is ruled by Saturn. Saturn is retrograde in
> Aries, conjunction your natal Moon. The cosmos is skeptical of this
> (p = 0.27).

The headline is **Firmly 👎**: below 0.5 gives 👎, and being at least 0.2
away from 0.5 makes it "Firmly". Total for this question: two calls,
1,500 input tokens, **$0.000063**.

### The other routes, from the same capture session

Only the `answers` that decided the route are shown; full bodies are in the
JSON file.

| Activity | Call 1 answers that mattered | Route | Calls | What the user sees |
|---|---|---|---|---|
| "Should I punch my neighbor" | `sensitivity: violence_person` (1.00) | recusal | 1 | "The stars recommend therapy for this one." |
| "Should I do the thing" | `vague` 0.93 (`category` best guess Mercury, only 0.42) | needs detail | 1 | "That's too vague for the stars to work with. …" |
| "Should I go bowling tonight" | `category: Mars` (0.81), `sensitivity: none` (0.98), `vague` 0.30 | verdict | 2 | Mars direct in Leo, no aspects, `favor` 0.40 → Tentatively 👎 |

A recusal never makes Call 2, so it costs half as much and no probability
exists to leak. Every Call 1 in the session billed exactly $0.000040194 (957
input tokens): the prompt is fixed apart from a few words of activity text.

# API reference (verified)

Checked 2026-09-26 against OpenRouter's and TypeSafe's own docs. If anything
here disagrees with the live docs, the live docs win: re-check and update this
file. Never guess endpoints, request shapes, or response fields.

Sources:
- https://openrouter.ai/docs/guides/community/jev-tutorial.md
- https://openrouter.ai/docs/guides/community/typesafe-sdk.md
- https://openrouter.ai/docs/api/api-reference/systemone/submit-a-system-one-request.md
- https://docs.typesafe.ai/api.md (TypeSafe's own reference; OpenRouter's System
  One API implements the same request/response shapes)

## Endpoint

```
POST https://openrouter.ai/api/v1/systemone
Authorization: Bearer <OPENROUTER_API_KEY>
Content-Type: application/json
```

`/api/alpha/decisions` also works but is marked alpha. Use `/api/v1/systemone`.

## Model IDs

- `typesafe/jev-1.13` — pinned release. Default for this project, so the
  routing threshold (vague ≥ 0.75) stays stable. Replies report the dated
  build, e.g. `typesafe/jev-1.13-20260917`.
- `~typesafe/jev-latest` — alias that tracks the newest Jev release.
- Bare IDs (`jev-1.13`, `jev-latest`) are mapped onto the `typesafe/` namespace.
- Make the model an env var (`JEV_MODEL`), defaulting to the pinned ID.

## Request

Required top-level fields: `model`, `state`, `questions`.

- `state`: string, object, or array.
- `questions`: map of your own question id → question object. All questions in
  one request are answered in parallel and cannot see each other's answers.

Question shapes:

| type     | `instructions`            | `criteria`                                                   |
|----------|---------------------------|--------------------------------------------------------------|
| `noul`   | required (the yes/no Q)   | optional: `{ "true": "...", "false": "..." }`                |
| `choice` | required                  | required: map of option → description (or `null`); max 255   |
| `score`  | required                  | required: ordered array of level descriptions; 2 to 10 levels |

```json
{
  "model": "typesafe/jev-1.13",
  "state": { "ticket": "..." },
  "questions": {
    "is_bug": {
      "type": "noul",
      "instructions": "Is the customer reporting a software defect?",
      "criteria": { "true": "...", "false": "..." }
    },
    "team": {
      "type": "choice",
      "instructions": "Which team should own this ticket?",
      "criteria": { "payments": "...", "frontend": "..." }
    },
    "urgency": {
      "type": "score",
      "instructions": "How urgent is this ticket?",
      "criteria": ["Can wait", "This week", "Blocking now"]
    }
  }
}
```

## Response

```json
{
  "id": "gen-dec-...",
  "model": "typesafe/jev-1.13-20260917",
  "provider": "TypeSafe",
  "answers": {
    "is_bug": { "type": "noul", "noul": 0.96 },
    "team": {
      "type": "choice",
      "choice": "payments",
      "confidence": 0.67,
      "probabilities": { "payments": 0.78, "frontend": 0.22 }
    },
    "urgency": {
      "type": "score",
      "score": 1.99,
      "confidence": 0.99,
      "probabilities": { "0": 0, "1": 0, "2": 1 },
      "legend": { "0": "Can wait", "1": "This week", "2": "Blocking now" }
    }
  },
  "usage": { "input_tokens": 476, "output_tokens": 70, "cost": 0.000019992 }
}
```

- Noul: only `noul` (0–1, probability of yes). No confidence field.
- Choice: `choice` is the top option; `probabilities` covers every option.
- Score: `score` is the probability-weighted, **0-indexed** position on the
  scale. For a 0–1 "intensity", normalize: `score / (levels - 1)`.
- Jev returns no text and no reasoning trace.

## Errors (OpenRouter)

400, 401, 402 (insufficient credits), 403, 404, 413, 429, 500, 502, 503, 524,
529. Retry 429 and 5xx/529 with exponential backoff; do not retry 4xx client
errors. The Worker must never echo the API key or upstream auth details to the
client.

## Project rules that follow from this

- The OpenRouter key lives only in a Worker secret (`OPENROUTER_API_KEY`).
- Call 2 batches the Noul verdict and Score intensity in a single request.
- The client `JevOracle` talks to our Worker, never to OpenRouter directly.

## Spend throttle and admin endpoint (Worker-side)

Not OpenRouter behavior; our own layer on top of it.

- Each `POST /api/decide` caller is bucketed by `CF-Connecting-IP` (IPv6
  collapses to its `/64` prefix; a missing or malformed header shares the
  capped `unknown` bucket). Before proxying, the Worker checks the bucket's
  **rolling 7-day** spend against `SPEND_CAP_USD_PER_IP` (default `0.01`) in
  the `SPEND_TRACKER` Durable Object (`worker/spendLedger.ts`, SQLite-backed,
  free-plan eligible). At or over the cap: **429 `rate_limited`** (a
  distinct, worker-generated message — upstream 429s read "The oracle is
  busy…") with no upstream call.
- After a successful upstream reply the Worker charges the reply's exact
  `usage.cost` to the bucket via `waitUntil`; a reply with no numeric cost
  charges a conservative fallback ($0.0001). Upstream failures charge
  nothing. Ledger or throttle-config failures answer **503 rather than
  proxying unbilled traffic** (fail-closed).
- `THROTTLE_EXEMPT_IPS` (Worker **secret** — it names the operator's IPs):
  comma-separated IPv4 addresses and IPv6 `/64` prefixes. Exempt buckets skip
  enforcement but are still metered.
- `GET /api/admin/spend` returns
  `{ window_days, cap_usd, generated_at, total_usd, buckets: [{ bucket, spend_7d_usd, total_usd, last_charge_at }] }`,
  same origin allowlist, unmetered. Exempt buckets are omitted from `buckets`
  (so the operator's IPs are never published) but counted in `total_usd`.
  `admin.html` (a second, unlinked page of the FE build) renders this JSON.
  **It has no auth**: the URL obscurity is the only "gate", and anyone who
  finds it can read bucketed IPs and spend. The OpenRouter key credit limit
  remains the real backstop.
