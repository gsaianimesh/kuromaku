# Progress

Append-only log. One entry per phase: what was built, what was decided, what was deferred.

---

## Phase 0 — Scaffold, BYOK, health

**Status:** complete. All acceptance checks pass except the live Vercel URL, which is blocked
on account access (see Deferred).

### Built

- Next.js 16 (App Router, Turbopack) + TypeScript + Tailwind 4, at the repo root.
- Neon Postgres via `@neondatabase/serverless`, Drizzle ORM, migrations checked in under
  [drizzle/](drizzle/).
- Phase 0 schema only: `workspaces`, `settings`. The remaining tables from SPEC §6 land in Phase 1.
- AES-256-GCM secret envelope in [src/lib/crypto.ts](src/lib/crypto.ts), versioned wire format
  `[version:1][iv:12][authTag:16][ciphertext:n]`.
- BYOK settings screen at `/settings`. Saves a key, reports the round trip result read back
  from Postgres, and shows only the last 4 characters thereafter.
- Health surface: `/health` (UI) and `/api/health` (JSON, 503 on failure). Checks environment,
  database connectivity, migration state and the encryption round trip.
- Headless acceptance runner: `npm run verify`.

### Decisions

- **Groq instead of the Anthropic SDK named in SPEC §5.** The available API key is a Groq key.
  Rather than hardcoding either, settings carry a `model_provider` column and key resolution
  goes through one seam (`resolveModelKey`), so the provider is a config value. The task-routing
  config object required by SPEC §5 arrives in Phase 3 with the first real model call.
- **Lazy environment and database initialisation.** `getEnv()` and `getDb()` construct on first
  use rather than at import time, so a missing variable renders as a readable failure on
  `/health` instead of crashing the process. SPEC §0: never leave main broken.
- **Single-tenant for v1.** No auth. One seed workspace (ShogunAI / shogunaios.com). Every table
  still carries `workspace_id`, so multi-tenant is a routing change rather than a migration.
- **No light mode.** SPEC §8 asks for dark and dense; supporting both doubles the surface for
  no benefit in an internal tool.
- **Key display is capped at the last 4 characters** and the plaintext is cleared from the DOM
  on submit. The plaintext key is never returned to the browser and never logged.
- **`npm` rather than `pnpm`.** `corepack prepare pnpm` hung in this environment. SPEC §7.10
  names `pnpm eval`; that will be `npm run eval` unless pnpm becomes available.

### Deferred

- **Live Vercel URL (SPEC §9 Phase 0).** Requires the account owner to run `vercel link` once.
  Instructions are in [README.md](README.md#deploy). Everything else in Phase 0 is verified
  against the real Neon database.
- **Three-pane layout (SPEC §8).** Phase 0 has three screens and nothing to put in the side
  panes. The shell is in place; the panes get built in Phase 4 when memory and jobs exist,
  rather than being scaffolded empty now.

### Acceptance checks

| Check (SPEC §9) | Result | Evidence |
| --- | --- | --- |
| Live URL loads | **deferred** | Blocked on `vercel link`. Verified locally: `/`, `/health`, `/settings`, `/api/health` all return 200 from a production build. |
| Key saves and round trips | **pass** | `npm run verify` — key stored as a 72-char ciphertext envelope, read back from Postgres and decrypted, tail matches input. |
| Migrations run clean | **pass** | `npm run db:migrate` applied `0000_phase0_workspaces_settings`; health reports 2/2 expected tables. |
