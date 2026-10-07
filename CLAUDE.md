# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:6cd5cc61 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->


## Build & Test

Requires Node >= 22.12 (Vitest 5 and Wrangler 4). Install once with `npm install`.

```bash
npm run dev         # Vite dev server (http://localhost:5173)
npm run build       # typecheck, then production build to dist/
npm test            # Vitest, single run
npm run typecheck   # tsc --noEmit over src/, worker/ and vite.config.ts
npx wrangler deploy --dry-run --outdir /tmp/wr --config worker/wrangler.toml   # verify the Worker bundles
```

- Oracle selection: `VITE_ORACLE=stub|jev` (default `stub`), read in `src/config.ts`. It is a build-time, non-secret value. Never put the OpenRouter key in a `VITE_` variable.
- Worker secrets go in `.dev.vars` locally (gitignored) or `wrangler secret put` when deployed.

## Architecture Overview

Cosmic JEV: a Vite + TypeScript SPA that turns a birthdate and an activity into a 👍/👎 "verdict" from real planetary positions (`astronomy-engine`), interpreted by TypeSafe's Jev model through OpenRouter. A Cloudflare Worker proxies Jev calls so the API key never ships to the client.

- `src/sky.ts` — astronomy module (the part that must be correct)
- `src/oracle.ts` — `Oracle` interface, `JevOracle`, `StubOracle`
- `worker/` — Cloudflare Worker proxy
- `docs/spec.md` — project brief and source of truth; `docs/jev-openrouter.md` — verified Jev API notes

## Conventions & Patterns

- Work is tracked in beads (`oracle-*`); route it through the `developer`, `tester` and `reviewer` agents in `.claude/agents/`.
- Never guess Jev/OpenRouter API shapes or ephemeris reference values. Use `docs/jev-openrouter.md` or the live docs, and cite sources in tests.
- `OPENROUTER_API_KEY` lives only in a Worker secret. Nothing about the user is stored server-side.
- Explanation text is templated from typed results. No LLM-generated horoscope text.
