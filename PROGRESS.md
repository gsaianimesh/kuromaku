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

---

## Phase 1 — Schema and jobs

**Status:** complete. All acceptance checks pass. 18/18 in `npm run verify`.

### Built

- Every table from SPEC §6: `sources`, `memory_records`, `record_sources`, `research_cache`,
  `jobs`, `agent_runs`, `artifacts`, `artifact_evidence`, `reviews`, `observations`,
  `coverage_gaps`, on top of Phase 0's `workspaces` and `settings`. Nine Postgres enums for the
  closed status sets, and indexes covering the queue claim path and the staleness graph.
- Postgres-backed queue in [src/lib/jobs/queue.ts](src/lib/jobs/queue.ts): idempotent enqueue,
  atomic claim, retry with exponential backoff, and stale-lock recovery.
- Handler registry with payload validation folded in, and one `noop` job type.
- Worker in [src/lib/jobs/worker.ts](src/lib/jobs/worker.ts) with a job cap and a wall-clock
  budget, exposed at `/api/worker`, driven by a 5-minute Vercel cron and a manual button.
- Jobs UI: queue table with status counts, an enqueue form, a run-worker button that streams
  back per-job outcomes and logs, and a per-job inspector at `/jobs/[id]`.

### Decisions

- **Claiming is one statement, not a transaction.** The Neon HTTP driver runs each statement in
  its own implicit transaction, so a standalone `SELECT … FOR UPDATE SKIP LOCKED` would release
  its lock before the follow-up UPDATE ran and two workers could claim the same row. The select
  is nested inside the UPDATE, which keeps lock and write atomic while still using
  `FOR UPDATE SKIP LOCKED` as SPEC §5 requires. Verified with two concurrent claims taking
  distinct rows.
- **The idempotency unique index is partial: `WHERE status <> 'failed'`.** SPEC §6 says the key
  is unique; SPEC §7.4 says never schedule a key that exists *in a non-failed state*. A plain
  unique index would let one permanent failure poison that key forever, so the planner could
  never retry that work. The partial index satisfies both readings. Enqueueing the same key
  twice while a job is queued, running or done still yields exactly one job.
- **Added `run_after` and `max_attempts`** to `jobs`, beyond the columns SPEC §6 lists. Retry
  backoff needs somewhere to record when a job becomes runnable again, and per-job attempt
  limits belong on the row rather than in a constant. §6 says names are indicative and structure
  is not, so this reads as within scope.
- **`agents` is not a table.** SPEC §6 says the registry is seeded in code. Artifacts and runs
  reference agents by string id with no foreign key.
- **Stale-lock recovery runs at the start of every worker invocation.** Without it a crashed
  serverless run strands a row in `running` forever and the work silently never happens — the
  same class of defect as SPEC §2's duplicate execution, in the other direction.
- **`content` is never overwritten on artifacts**; human edits go to `content_final`. Edit
  distance in Phase 5 depends on both surviving.

### Deferred

- **Live Vercel URL.** The deployment exists at `kuromaku-nine.vercel.app` but has no environment
  variables set, so it answers 503 from `/api/health` with the exact list of what is missing.
  Setting them needs dashboard access. The health endpoint failing legibly rather than crashing
  is the designed behaviour.
- **`CRON_SECRET` is unset**, so `/api/worker` is currently open. Harmless locally — it only
  drains a queue that only this app fills — but it must be set before the deployment is public.

### Acceptance checks

| Check (SPEC §9) | Result | Evidence |
| --- | --- | --- |
| Enqueue a no-op job from the UI, watch it claim, run and complete | **pass** | Verified through the real HTTP route: enqueue → `/api/worker` → `{outcome: "done", durationMs: 414}` with handler logs, job row `status=done, attempts=1, completed_at` set. |
| Enqueueing the same idempotency key twice creates one job | **pass** | Two enqueues, one row. First returns `created=true`, second `created=false` with the same job id. |

Also verified beyond the stated checks: concurrent claims take distinct rows; a throwing job
requeues with backoff and retains its error; exhausting `maxAttempts` marks it failed; a failed
job releases its key; an unregistered job type fails with a readable message; a job whose worker
died is recovered rather than stranded.
