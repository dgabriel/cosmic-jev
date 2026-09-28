# Project: Cosmic Oracle — "Should I do this?"

A deadpan-funny web app: the user enters their birthdate and an activity, and
the app returns a thumbs up or down based on *real* planetary positions,
interpreted through traditional astrology by TypeSafe's Jev model. The joke is
the rigor: correct astronomy, typed answers, calibrated-looking probabilities,
all serving an absurd question.

## Stack
- Vite + TypeScript, single-page app, no framework unless there's a clear need
- `astronomy-engine` (npm) for ephemeris math
- Cloudflare Worker as a thin proxy for Jev calls. The API key lives in a
  Worker secret and never ships to the client.

## Workflow
- Break this into beads issues (`bd`) before writing code and route work through
  the developer / tester / reviewer subagents as usual.
- Build and test the astronomy module first. It's the only part that must be
  *correct*.

## 1. Astronomy module (`src/sky.ts`)
Bodies: Sun, Moon, Mercury, Venus, Mars, Jupiter, Saturn.

**Transit chart (now):** for each body compute
- geocentric ecliptic longitude (tropical, of date) via
  `Astronomy.Ecliptic(Astronomy.GeoVector(body, date, true)).elon`
- sign (`floor(lon / 30)`) and degree within sign
- retrograde status (compare against +24h, handle the 360°→0° wraparound;
  the Sun and Moon are never retrograde)
- Moon phase name

**Natal chart (from user input):**
- Required: birthdate. Optional: birth time, birth location.
- Without a birth time, compute positions at local noon and flag any body that
  changes sign during that day as `ambiguous: true` (this covers Sun cusp days
  and frequent Moon ambiguity).
- Only compute the Ascendant if both time and location are given.

**Aspects:** compute aspects from each transiting body to the natal Sun (and
natal Moon if not ambiguous): conjunction 0°, sextile 60°, square 90°,
trine 120°, opposition 180°, using conventional orbs (document your choices).
Output a clean list: `{ transit, natal, aspect, orb, applying }`.

Tests: verify signs and Mercury retrograde status for at least 3 dates against
a reference ephemeris (e.g., JPL Horizons or a published retrograde calendar).
Look the values up and cite the source in a test comment. Do NOT invent
expected values. Include a Pisces→Aries wraparound test and a Sun cusp-day
ambiguity test.

## 2. Oracle (`src/oracle.ts` + `worker/`)
- Jev is a "System One" model from TypeSafe AI: it takes a state (text/JSON) and
  typed questions (Choice, Score, or Noul, which is a yes/no probability) and
  returns typed answers with probabilities. It does not generate text.
- **Check TypeSafe's current API docs before writing the client.** Do not guess
  endpoints, request shapes, or response fields. If the docs aren't reachable,
  stop and tell me.
- Interface `Oracle` with `JevOracle` (real) and `StubOracle` (deterministic,
  seeded from chart + activity text, so the app works without a key and tests
  are stable). Select via env var.

**Call 1: classify the activity** (state = the activity text only)
- Choice, category → ruling body:
  - Mars: sports, exercise, competition, confrontation, bold new starts
  - Venus: romance, dating, art, beauty, fashion, socializing, treats
  - Mercury: communication, writing, emails, short trips, tech, contracts
  - Jupiter: learning, long travel, games of chance, celebrations
  - Saturn: work, chores, commitments, long-term planning
  - Moon: home, cooking, family, rest, self-care
  - Sun: performance, creative self-expression, being the center of attention
- Choice, sensitivity → one bucket per activity (oracle-2au):
  - `violence_person`: violence or harm directed at a person or animal,
    including the asker harming themselves (self-harm, suicide-adjacent
    text)
  - `safety`, `legal`
  - `health` (never self-harm -- that is always `violence_person`), `money`,
    `relationship_ending`, `job_quitting`
  - `violence_object`: violence or destruction directed at an inanimate
    object only (smashing a printer, punching a wall)
  - `none`
- Noul: "Is this activity description too vague to categorize?"

Routing, in this priority order:
- `violence_person` → playful recusal ("The stars recuse themselves from
  this one."), always, checked before anything else. No verdict, no
  probability shown, and nothing else in the routing can override this into
  a verdict.
- `safety`, `legal` → same recusal, no exceptions.
- vague p ≥ 0.6 → ask the user to be more specific
- `health`, `money`, `relationship_ending`, `job_quitting` → Call 2, and
  show the verdict together with a visible "this is not real advice"
  disclaimer; keep the tone light
- `violence_object`, `none` → Call 2, no special handling

Whenever the bucket is ambiguous, bias toward recusal: false alarms are
cheap and misses aren't funny.

**Call 2: the verdict** (state = category, ruling body's transit position and
retrograde status, relevant aspect list, Moon phase, the activity text)
- Noul: "Do the stars favor this activity for this person today?"
- Score: cosmic intensity (0–1), used only for flavor copy
- Batch both questions in one call.

## 3. UI
- Inputs: birthdate (required), birth time + location (optional, collapsed),
  activity (free text)
- Result: a big 👍 or 👎, with "firmly" vs "tentatively" based on distance
  from 0.5. Verdicts in the disclaimer buckets (health, money,
  relationship-ending, job-quitting) additionally show the disclaimer as a
  visibly separate element next to the explanation.
- Deadpan explanation templated from the typed results. No LLM-generated text.
  Example: "Bowling is ruled by Mars. Mars is direct in Aries, trine your natal
  Sun. The cosmos endorses this (p = 0.81). Firmly 👍."
- SVG zodiac wheel with natal planets on the inner ring and transits on the
  outer ring; retrograde planets marked ℞; aspect lines to the natal Sun
- Show ambiguity honestly: "Born on a cusp. Add a birth time to settle it."
- Responsive, light/dark aware. No accounts; nothing stored server-side.

## 4. Stretch (separate beads issues, only after the core works)
- Group mode: several birthdates + one activity → group verdict
- Post-activity feedback: 👍/👎 on how it actually went, stored locally, plus a
  tongue-in-cheek "cosmic calibration" chart over time
- Shareable result card image

## Non-goals
- No written horoscope text and no scraped horoscope content
- No verdicts on violence toward a person or animal (including self-harm),
  safety, or legal questions, ever -- those always recuse (see routing
  above). Health, money, relationship-ending, and job-quitting questions do
  get verdicts, always with a visible disclaimer.
- No storing birthdates server-side

## Amendment: Jev is called via OpenRouter
Jev is reached through OpenRouter, not TypeSafe's own endpoint. See
`docs/jev-openrouter.md` for the verified request/response shapes. The Worker
secret is the OpenRouter API key.

## Amendment: art-project overhaul supersedes this doc's UI section

Section 3's UI (plain form + deadpan 👍/👎 card) is superseded by the
"Cosmic JEV does Haruspicy" bar-napkin spec (see the plan at
`/Users/dgabriel/.claude/plans/we-now-have-an-vectorized-pearl.md`): a
multi-beat deep-fried experience (splash, star-field/constellation reveal,
haruspicy flicker, emoji-thumb verdict) replacing the plain result card. In
particular, `explainVerdict`'s sentence (section 3's example) no longer ends
in `"Firmly 👍."` -- that trailing clause was dropped once the new
headline/thumb copy (`src/experience/copy.ts`) took over signaling
firmness/direction, to avoid saying the same thing twice.

The sign-resolve beat shows the natal Sun's real constellation shape (star
field particles rearranged into it, `src/experience/constellations.ts`), not
the SVG zodiac wheel this section originally called for -- `zodiacWheel.ts`
still exists in the repo but is unused. A stop-sign "consent gate" screen
briefly ran between the splash and the form; it was cut entirely per the
project owner ("kill the stop sign").
