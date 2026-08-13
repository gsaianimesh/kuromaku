# Kuromaku

An internal growth system that turns a company website into a **versioned marketing memory**,
then runs channel agents that draft from that memory, capture human feedback, and adapt based on
observed performance.

> **The thesis:** existing tools compile context once and then forget. This one remembers.

Five commitments, each visible in the UI rather than only in the code:

| Commitment | What it means |
| --- | --- |
| **Provenance on every fact** | No memory record exists without a source URL or an explicit *asserted by human* marker, plus a confidence value. |
| **Versioned memory** | Records are append-only. Editing supersedes rather than overwrites, and every derived artifact is marked stale. |
| **Agents derived from strategy** | The planner schedules from channel priorities. A prioritised channel with no agent becomes a visible **coverage gap**, not silence. |
| **Evidence, not justification** | Every draft carries the memory record IDs, source links and data points it used. Each is clickable and correctable. |
| **Performance closes the loop** | Observations feed the planner. Nothing displays a number that was not observed. |

The seed workspace is **ShogunAI** (shogunaios.com).

Build status per phase is in [PROGRESS.md](PROGRESS.md). **Currently at the end of Phase 1.**

---

## Quick start

Requires Node 20+ and a Neon (or any) Postgres database.

```bash
npm install
cp .env.example .env.local     # then fill in the values below
npm run db:migrate
npm run dev                    # http://localhost:3000
```

### Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | Neon **pooled** connection string, used at runtime. |
| `DATABASE_URL_UNPOOLED` | for migrations | Neon **direct** connection string, used by drizzle-kit. |
| `APP_ENCRYPTION_KEY` | yes | 32 random bytes, base64. Encrypts BYOK model keys at rest. |
| `GROQ_API_KEY` | no | Local-development fallback only. Production uses BYOK via `/settings`. |

Generate an encryption key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Rotating `APP_ENCRYPTION_KEY` makes every stored BYOK key undecryptable. The settings screen
reports that state explicitly rather than failing silently.

### Verify the install

```bash
npm run verify
```

Runs every phase's acceptance checks against the real database: environment, connectivity,
migration state, the BYOK encrypt → Postgres → decrypt cycle, and the full job queue contract
(idempotency, concurrent claim safety, retry with backoff, failure, stale-lock recovery).
Non-destructive — any existing key is restored and every test job is deleted.

`/api/health` returns the same report as JSON and answers 503 when a check fails.

---

## Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run db:generate` | Generate a migration from schema changes |
| `npm run db:migrate` | Apply migrations |
| `npm run db:studio` | Drizzle Studio |
| `npm run verify` | Headless acceptance checks |

---

## Deploy

Deployment is to Vercel. The repo is deploy-ready; linking needs to happen once from an account
that owns the project.

```bash
npx vercel link            # once, interactive
npx vercel env add DATABASE_URL production
npx vercel env add DATABASE_URL_UNPOOLED production
npx vercel env add APP_ENCRYPTION_KEY production
npx vercel --prod
```

Use the same `APP_ENCRYPTION_KEY` as local if you want locally-stored BYOK keys to remain
readable in production. Otherwise generate a fresh one and re-enter the key in `/settings`.

---

## Architecture

```
src/
  app/
    page.tsx           Overview: health, workspace, build progress
    jobs/              Queue table, enqueue form, worker button, [id] inspector
    health/            Health UI
    settings/          BYOK key, provider selection
    api/health/        Health JSON (503 on failure)
    api/worker/        Drains the queue; cron target and "run now" target
  components/
    nav.tsx            Only routes that exist are linked
    ui.tsx             Panel, Row, Badge, StatusDot, Empty
  lib/
    env.ts             Zod-validated environment, lazy
    crypto.ts          AES-256-GCM secret envelope
    db/                Drizzle client and schema
    jobs/
      queue.ts         Enqueue, claim, complete, fail, recover
      handlers.ts      Job type registry with payload validation
      worker.ts        Drain loop with job cap and time budget
    settings.ts        BYOK storage and key resolution
    workspace.ts       Seed workspace bootstrap
    health.ts          Health checks
drizzle/               Checked-in migrations
scripts/verify.ts      Headless acceptance checks for every phase
```

### The queue

A `jobs` table plus a worker route — no third-party queue service (SPEC §5). Two details matter:

**Claiming is a single statement.** The Neon HTTP driver runs each statement in its own implicit
transaction, so a standalone `SELECT … FOR UPDATE SKIP LOCKED` would drop its lock before the
follow-up `UPDATE` and two workers could claim the same row. The select is nested inside the
update:

```sql
UPDATE jobs SET status = 'running', locked_at = now(), attempts = attempts + 1
WHERE id = (
  SELECT id FROM jobs
  WHERE status = 'queued' AND run_after <= now()
  ORDER BY run_after, created_at
  FOR UPDATE SKIP LOCKED LIMIT 1
) RETURNING *;
```

**The idempotency index is partial** — `UNIQUE (idempotency_key) WHERE status <> 'failed'`. A
plain unique index would let a single permanent failure reserve that key forever, so the planner
could never retry that work. Enqueueing the same key twice while a job is queued, running or done
still produces exactly one job.

### Stack

Next.js 16 (App Router) · TypeScript · Tailwind 4 · Neon Postgres · Drizzle ORM · Zod.
Jobs will run on a Postgres-backed queue (`SELECT … FOR UPDATE SKIP LOCKED`) rather than a
third-party queue service.

### Hard rules

These are enforced in code, not just documented:

- **Never auto-publish.** No agent posts anywhere. Publishing is a separate human action, and for
  Reddit and Hacker News the only supported flow is copy-to-clipboard plus a manual
  "I posted this, here is the URL" confirmation.
- **Never fabricate a metric.** If it was not observed, the UI shows an empty state.
- **BYOK.** Model keys are supplied by the user, encrypted at rest, never committed, never logged.
- **Every model call is logged** with prompt, model, token counts and cost, inspectable in the UI.
- **Every job is idempotent.** Jobs carry an idempotency key; research queries are cached and
  deduplicated by normalised query hash.
