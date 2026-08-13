# Kuromaku

An internal growth system that turns a company website into a **versioned marketing
memory**, then runs channel agents that draft from that memory, capture human
feedback, and adapt based on observed performance.

> **Okara compiles context once and then forgets. This is the version that remembers.**

It is a rebuild of [Okara](https://okara.ai), an "AI CMO" product. The insight worth
keeping is the shared strategy layer: agents don't each re-derive context, they read
one compiled set of records, which is why output stays consistent across channels.
Everything else here exists to fix something that layer doesn't do.

---

## What was wrong with the original

These are observations from a first-hand session with Okara, not from its marketing.
Each one became a requirement, and each is answered by a specific mechanism here.

| What it did | What this does instead | Where |
|---|---|---|
| **Strategy and execution disconnected.** Ranked Product Hunt third and founder communities fourth, had no agent for either, and shipped UGC video and influencer agents its strategy never asked for. | The planner compares compiled channel priorities against the registered agents. A prioritised channel with no agent becomes a **visible coverage gap**, not silence. | `/planner` · [planner.ts](src/lib/planner.ts) |
| **The 30-day roadmap was a dead document** — empty checkboxes in a PDF. | Roadmap items compile into memory records and the planner turns them into real jobs with real status. | [planner.ts](src/lib/planner.ts) |
| **No staleness tracking.** Editing the ICP left every derived draft unchanged and unflagged. | Records are append-only. Editing supersedes, and every artifact whose evidence cites the old record is **marked stale** with a regenerate option. | `/memory` → `/review` · [memory.ts](src/lib/memory.ts) |
| **Rationale without evidence** — a prose "why this works" panel with no links, no named threads, no data. | Every draft ships structured evidence: memory record ids, source links, data points. Each is clickable and resolves to a real record or a real URL. | `/review` |
| **Fabricated metrics** — unpublished drafts rendered invented like and view counts. | Nothing displays a number that wasn't observed. Empty states say so in words. An unpriced model shows as *unpriced*, never `$0.00`. | `/metrics` · [publish.ts](src/lib/publish.ts) |
| **Duplicate execution** — the whole onboarding pipeline ran twice in one session, one search query fired twice inside a single run. | Every job carries an idempotency key enforced by a partial unique index. Research is cached and deduplicated by normalised query hash. | [queue.ts](src/lib/jobs/queue.ts) · [search](src/lib/search/index.ts) |
| **No provenance.** Facts asserted flat; a wrong integration list and a latency claim with no source, baked into memory forever. | No record exists without a source or an explicit unsourced flag, plus a confidence value. Citations are **resolved against what the model was actually shown** — a hallucinated source index is dropped, and the record is capped below 0.5 confidence. | `/memory` · [compile](src/lib/compile/index.ts) |
| **Voice inferred from a landing page** when socials were skipped. | Voice rules compile per locale. A locale with no source material in that language yields low-confidence rules that *say* the material is missing, rather than translated English rules presented as observed. | `/memory` (filter by locale) |
| **Performance optional and unused.** The pipeline completed with Search Console and Analytics skipped and nothing degraded. | Observations feed the planner. A channel with recent drafts and no observations stops being scheduled, and the planner says why. | `/publish` → `/planner` |

---

## The five commitments

Each is visible in the UI, not just in the code.

1. **Provenance on every fact** — source URL or an explicit human assertion, plus confidence.
2. **Versioned memory with staleness propagation** — append-only; editing invalidates what came from it.
3. **The agent set is derived from the strategy** — uncovered priorities surface as coverage gaps.
4. **Evidence, not justification** — record ids and links, clickable and correctable.
5. **Performance closes the loop** — if nothing performed, the plan changes.

**Five-minute demo script: [WALKTHROUGH.md](WALKTHROUGH.md).**
Build log and per-phase decisions: [PROGRESS.md](PROGRESS.md).

The seed workspace is **ShogunAI** (shogunaios.com) — a macOS app that passively
captures work context into a private local memory. Local-first, encrypted on device,
BYOK. Its ICP is founders and solo operators; its channels are X, Hacker News,
Product Hunt and indie communities.

---

## Quick start

Requires Node 20+, a Postgres database (Neon by default), and a model API key.

```bash
npm install
cp .env.example .env.local     # fill in the values below
npm run db:migrate
npm run dev                    # http://localhost:3000
```

Then, in the app:

1. **`/settings`** — paste a model key (or set `GROQ_API_KEY` in `.env.local`).
2. **`/sources`** — queue a crawl of `shogunaios.com`, then run it.
3. **`/memory`** — queue a compile, then run it. Takes about five minutes on a
   rate-limited free tier; the waits are printed as they happen.
4. **`/planner`** — run the planner. Coverage gaps appear.
5. **`/review`** — run queued work, then approve or edit a draft.

### Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | Neon **pooled** connection string, used at runtime. |
| `DATABASE_URL_UNPOOLED` | for migrations | Neon **direct** connection string, used by drizzle-kit. |
| `APP_ENCRYPTION_KEY` | yes | 32 random bytes, base64. Encrypts BYOK model keys at rest. |
| `GROQ_API_KEY` | dev only | Local fallback. Production uses BYOK via `/settings`. |
| `ANTHROPIC_API_KEY` | dev only | Same, if you switch the provider. |
| `TAVILY_API_KEY` | optional | Enables web research. Without it the competitors stage degrades honestly rather than inventing competitors. |
| `CRON_SECRET` | production | Required bearer token for `/api/worker`. Unset leaves the route open. |

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### Verifying

```bash
npm run verify   # infrastructure invariants — fast, no model calls
npm run e2e      # full walk of the definition of done — makes real model calls
npm run eval     # golden set: 20 assertion-based cases (SPEC 7.10)
```

`/api/health` returns the same report as `npm run verify` in JSON and answers 503
when a check fails.

---

## Architecture

```
src/
  app/
    memory/      Records grouped by type, with sources, history, and inline edit
    review/      The daily surface: content, evidence, critic score, approve/edit/reject
    planner/     Channel priorities vs agent coverage; coverage gaps
    publish/     Copy-and-confirm, markdown export, observation intake
    metrics/     Edit distance per agent over time; observations
    sources/     Crawled pages with content hashes
    jobs/        Queue and per-job run inspector (prompt, tokens, cost)
    api/
      v1/        REST: memory, artifacts, agents, observations
      mcp/       MCP server (JSON-RPC over Streamable HTTP)
      worker/    Queue drain; cron target
  lib/
    compile/     The strategy compiler chain
    agents/      Registry (code-seeded), contract, implementations, runner
    jobs/        Queue, handler registry, worker
    model/       Provider seam (Groq + Anthropic), routing config, pricing, rate limiting
    search/      SearchProvider interface + permanent per-workspace cache
    memory.ts    Read, edit, supersede, propagate staleness
    planner.ts   Scheduling, coverage gaps
    review.ts    Decisions, edit distance, series for the chart
    publish.ts   Publish targets, markdown export, observations
    critic.ts    Score, revise once below threshold, re-score
eval/golden.ts   The golden set
```

### Design decisions worth knowing

**Claiming a job is one statement, not a transaction.** The Neon HTTP driver runs
each statement in its own implicit transaction, so a standalone
`SELECT … FOR UPDATE SKIP LOCKED` would drop its lock before the follow-up UPDATE
and two workers could claim the same row. The select is nested inside the update.

**The idempotency index is partial** — `UNIQUE (idempotency_key) WHERE status IN
('queued','running')`. The queue's job is preventing *concurrent* duplicate
execution; terminal rows release their key because re-running is required
behaviour (re-crawl, re-compile). Not scheduling *redundant* work is a planning
decision and lives in the planner.

**Provenance is enforced after the model returns, never trusted from it.** A cited
source index must resolve to a source that was actually in the prompt; a cited URL
must appear in search results that actually came back. Anything that fails to
resolve is dropped from the citations — not from the record. The record survives,
flagged unsourced, capped below 0.5 confidence.

**A stage's output is authoritative for its type.** On re-compile, a record that
existed before and was not re-emitted is superseded rather than left active —
otherwise a re-compile that drops a fact leaves the stale one sitting in memory
looking current, which is the exact defect this system exists to fix.

**Providers sit behind one seam.** `ModelProvider` has a Groq implementation
(OpenAI-compatible) and an Anthropic one. Task routing is a single config object
(`MODEL_CONFIG`) mapping compile/critique/draft/classify to models per provider.
Rate limits are read from response headers and waited out rather than guessed.

**The chart's palette was validated, not eyeballed.** The four categorical hues
pass a lightness band, chroma floor, colorblind separation (ΔE 9.6 deutan),
normal-vision separation, and contrast against the chart surface.

### Stack

Next.js 16 (App Router) · TypeScript · Tailwind 4 · Neon Postgres · Drizzle ORM ·
Zod · Groq (Anthropic behind the same seam). Jobs run on a Postgres queue with
`SELECT … FOR UPDATE SKIP LOCKED`, not a third-party queue service.

---

## The API

Okara is closed — no API, no MCP. Being open is the point, and it matches what
ShogunAI itself is built on.

```bash
curl localhost:3000/api/v1/memory?type=positioning
curl localhost:3000/api/v1/artifacts?status=draft
curl localhost:3000/api/v1/agents
curl -X POST localhost:3000/api/v1/observations \
  -H 'content-type: application/json' \
  -d '{"artifactId":"…","metric":"upvotes","value":42}'
```

Every memory record returned carries its sources and an `unsourced` flag — a fact
without its provenance is the thing this system exists to avoid, and that holds
whether a human or another agent is reading it.

### MCP

`POST /api/mcp` speaks JSON-RPC 2.0 over Streamable HTTP. `GET /api/mcp` returns
the manifest. Tools: `get_memory`, `search_memory`, `list_artifacts`, `run_agent`,
`record_observation`, `list_coverage_gaps`.

```json
{ "mcpServers": { "kuromaku": { "url": "http://localhost:3000/api/mcp" } } }
```

`run_agent` queues work and returns a job id. It never publishes — the draft lands
in the review queue for a human, like everything else.

---

## Hard rules, enforced in code

- **Never auto-publish.** No agent posts anywhere. Publishing requires an explicit
  human click, and for Reddit and Hacker News the only supported flow is copy to
  clipboard plus a manual "I posted this, here is the URL" confirmation. Automated
  posting to those platforms violates their rules.
- **Never fabricate a metric.** If it wasn't observed, the UI shows an empty state
  and says why it is empty.
- **BYOK.** Model keys are supplied by the user, encrypted with AES-256-GCM at
  rest, never committed, never logged, never returned to the browser.
- **Every model call is logged** with prompt, model, token counts and cost, and is
  inspectable at `/jobs/<id>`.
- **Every job is idempotent** and every research query is cached and deduplicated
  by normalised query hash.

---

## Deploy

```bash
npx vercel link
npx vercel env add DATABASE_URL production
npx vercel env add DATABASE_URL_UNPOOLED production
npx vercel env add APP_ENCRYPTION_KEY production
npx vercel env add CRON_SECRET production
npx vercel --prod
```

`vercel.json` registers a 5-minute cron against `/api/worker`. Note that a full
compile can exceed the 60-second function limit on Hobby — the queue is built for
this (a job that doesn't finish is recovered by the stale-lock check and retried),
but for a smooth demo run the compile locally.
