# 11. Configuration and deployment

## Environment variables

Validated by [`src/lib/env.ts`](../src/lib/env.ts) with Zod, lazily.

| Variable | Required | Validation | Purpose |
|---|---|---|---|
| `DATABASE_URL` | Yes | non-empty | Neon **pooled** connection, used at runtime |
| `DATABASE_URL_UNPOOLED` | For migrations | optional | Neon **direct** connection, used by drizzle-kit |
| `APP_ENCRYPTION_KEY` | Yes | must decode to exactly 32 bytes of base64 | Encrypts BYOK model keys |
| `GROQ_API_KEY` | No | optional | Local-development model fallback |
| `ANTHROPIC_API_KEY` | No | optional | Same, for the Anthropic provider |
| `CRON_SECRET` | Production | optional | Bearer token for `/api/worker` |
| `TAVILY_API_KEY` | No | not validated | Web research |
| `BRAVE_API_KEY` / `EXA_API_KEY` | No | not validated | Alternative search providers |

Search keys are read directly from `process.env` in
[`src/lib/search/index.ts`](../src/lib/search/index.ts) rather than through the
validated schema:

```ts
/**
 * Search keys live in the environment. They are not workspace secrets in the
 * way the model key is: BYOK in SPEC section 4 is specifically about the model
 * key, and adding a second encrypted-secret surface for a provider that may
 * not be configured at all is not worth the complexity yet.
 */
```

### Empty strings count as unset

```ts
/**
 * Hosting dashboards frequently hand back "" for a variable that was never
 * filled in. Treat empty as absent so an optional variable stays optional.
 */
const optionalStr = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.string().optional(),
);
```

This was written after a deployment reported `DATABASE_URL_UNPOOLED: Too small`
for a variable that had never been set.

### Validation is lazy and non-fatal at import

`getEnv()` throws on invalid environment, but nothing calls it at module load.
`checkEnv()` is the non-throwing variant used by `/health`, so a missing
variable renders as a readable failure rather than crashing the process:

```ts
export function checkEnv():
  | { ok: true; env: ServerEnv }
  | { ok: false; missing: string[] }
```

Generate an encryption key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

**Rotating `APP_ENCRYPTION_KEY` makes every stored BYOK key undecryptable.**
`/settings` reports that state explicitly as `undecryptable` rather than
silently falling back.

## Local setup

```bash
npm install
cp .env.example .env.local        # fill in DATABASE_URL, APP_ENCRYPTION_KEY
npm run db:migrate
npm run dev                       # http://localhost:3000
```

Then, in order:

1. `/settings` — paste a model key, or set `GROQ_API_KEY` in `.env.local`
2. `/sources` — Queue crawl → Run crawl now
3. `/memory` — Queue compile → Run compile now *(several minutes; see below)*
4. `/planner` — Run planner now
5. `/review` — Run queued work

`/health` should be green before step 2. It is the fastest way to tell a
configuration problem from an application problem.

### Scripts

| Command | Does |
|---|---|
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run db:generate` | Generate a migration from schema changes |
| `npm run db:migrate` | Apply migrations |
| `npm run db:studio` | Drizzle Studio |
| `npm run verify` | Infrastructure acceptance checks |
| `npm run e2e` | Full pipeline against real model calls |
| `npm run eval` | Golden set |
| `npm run screenshots` | Regenerate documentation images |

Scripts that import server modules run through
`node --conditions=react-server --import tsx`. The condition is required because
`server-only` resolves to an empty module under `react-server` and throws
otherwise.

## The Neon driver configuration

[`src/lib/db/index.ts`](../src/lib/db/index.ts) installs a retrying fetch:

```ts
neonConfig.fetchFunction = retryingFetch;
const sql = neon(getEnv().DATABASE_URL);
```

`fetchFunction` is global-only configuration on the Neon driver, not a per-call
option. The retry policy and the reasoning behind it are in
[12 — Security](12-security.md) and
[15 — Known limitations](15-known-limitations.md).

Migrations use `DATABASE_URL_UNPOOLED` when present:

```ts
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
```

## Deployment

Target is Vercel. `vercel.json` is checked in:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "crons": [{ "path": "/api/worker", "schedule": "*/5 * * * *" }]
}
```

```bash
npx vercel link
npx vercel env add DATABASE_URL production
npx vercel env add DATABASE_URL_UNPOOLED production
npx vercel env add APP_ENCRYPTION_KEY production
npx vercel env add CRON_SECRET production
npx vercel --prod
```

Use the same `APP_ENCRYPTION_KEY` as local if locally-stored BYOK keys should
remain readable in production. Otherwise generate a fresh one and re-enter the
key at `/settings`.

Migrations are not run by the build. Run `npm run db:migrate` against the
production database before or after deploying.

### Cron authentication

Vercel sends `Authorization: Bearer {CRON_SECRET}` automatically when that
variable is set. The route checks it:

```ts
if (!secret) return true;
return req.headers.get("authorization") === `Bearer ${secret}`;
```

With the variable unset the route is open to anyone. Set it in production.

## The function timeout constraint

This is the sharpest deployment limitation.

```ts
export const maxDuration = 60;   // src/app/api/worker/route.ts
```

Vercel Hobby caps serverless functions at 60 seconds. A full compile takes
roughly five to ten minutes on a rate-limited model tier — most of it spent
waiting out an 8,000 tokens-per-minute budget. A compile triggered through
`/api/worker` on Hobby will be killed mid-flight.

### What happens when it is killed

The job stays `running` with a stale `locked_at`. Five minutes later the next
cron invocation calls `recoverStaleJobs()`, which routes it through `failJob` —
so it re-queues with backoff if attempts remain. Records written by stages that
completed before the kill are already committed, because the compiler commits
per stage.

The failure is therefore recoverable rather than corrupting, but it does not
converge: each attempt gets ~60 seconds and the compile needs several minutes.

### Workarounds, in order of preference

**1. Run compiles locally.** `npm run dev` has no function timeout. This is what
the demo path does, and why the walkthrough says to compile before demoing.

**2. Raise `maxDuration`.** Vercel Pro allows 300 seconds:

```ts
export const maxDuration = 300;
```

Still short of a cold ten-minute compile, but enough for most, and enough for
every other job type.

**3. Raise the stale-lock threshold to match.** `STALE_LOCK_MS` is 5 minutes. A
job legitimately running longer than that gets reclaimed *while still running*,
producing two concurrent executions of the same job. If `maxDuration` is raised
past 300 seconds, raise `STALE_LOCK_MS` past it too.

**4. Make the compiler resumable.** Not implemented — see
[15](15-known-limitations.md). Stages already commit independently, so a
resumable compile that skips stages whose records already exist at the current
version is a plausible next step rather than a rewrite.

### Other jobs are within budget

Crawl, agent runs and the planner all complete inside 60 seconds under normal
conditions. Agent runs are the closest — two to four model calls, each of which
may wait out a rate-limit window. The `budgetMs` default of 25 seconds stops the
worker claiming a *new* job near the limit, but does not interrupt one in
flight.
