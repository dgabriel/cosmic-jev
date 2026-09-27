# Jev via OpenRouter — verified API notes

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

- `typesafe/jev-1.13` — pinned release. Default for this project, so the 0.3 /
  0.6 routing thresholds stay stable.
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
