# BUILD SPEC: Kuromaku

A build brief for Claude Code. Paste the whole file as your first message, or save it as
`SPEC.md` at the repo root and open with "Read SPEC.md and start Phase 0."

Working name: Kuromaku. Rename freely.

---

## 0. How to work

You are building a product, not answering a question. Follow these rules for the whole session.

- Work **phase by phase** in the order given in section 9. Do not skip ahead, do not scaffold future phases early.
- At the end of each phase, stop and report: what you built, how to run it, and the acceptance checks from that phase with pass or fail against each one. Wait for me before starting the next phase.
- Keep a `PROGRESS.md` at the repo root. After each phase, append what was completed, decisions made, and anything deferred.
- If a requirement here is ambiguous or you think it is wrong, say so and propose an alternative before building it. Do not silently reinterpret.
- Prefer boring, proven choices. This is judged on working software and clear architecture, not novelty.
- Every phase must end with the app running. Never leave main broken.
- Commit at the end of each phase with a descriptive message.

---

## 1. What this is

An internal growth system that turns a company website into a versioned marketing memory,
then runs channel agents that draft work from that memory, capture human feedback, and adapt
based on real performance.

It is a rebuild of Okara (okara.ai), an "AI CMO" product, with specific architectural changes
described in section 3. I have used Okara first hand and the observations in section 2 are from
that session, not from its marketing.

The first user is a real pre launch company: **ShogunAI** (shogunaios.com), a macOS app that
passively captures work context into a private local memory and feeds it to Claude, ChatGPT and
Cursor. Local first, encrypted on device, BYOK. Their ICP is founders and solo operators. Their
channels are X, Hacker News, Product Hunt and indie communities. Use them as the seed workspace
for every demo.

---

## 2. What Okara does, and what it gets wrong

**Its pipeline:** crawl the domain, generate a product description, a design guide, a brand voice
doc, run about nine competitor searches, generate a marketing strategy and a content strategy,
then spin up roughly ten channel agents (SEO, GEO, Reddit, Hacker News, X, LinkedIn, Articles,
UGC, Influencer, Coding). Every agent reads those documents before drafting. Drafts land in a feed
for human approval. It sells at 1290 to 2490 US dollars per year per website.

**The real insight worth keeping:** the shared strategy layer. Agents do not each re-derive context,
they read one compiled set of documents, which is why output stays consistent across channels.

**The defects I observed, each of which becomes a requirement below:**

1. **Strategy and execution are disconnected.** Its own strategy ranked Product Hunt third and
   founder communities fourth. It has no agent for either, while shipping UGC video and influencer
   agents its strategy never asked for. The agent catalogue is fixed and unrelated to the plan.
2. **The 30 day roadmap is a dead document.** Empty checkboxes in a PDF. No state, no tracking,
   nothing executes it.
3. **No staleness tracking.** Editing the ICP left every derived draft unchanged and unflagged.
4. **Rationale without evidence.** Drafts carry a prose "why this works" panel with no links, no
   named threads, no data, no reference to which memory record informed the choice.
5. **Fabricated metrics.** Unpublished drafts render with invented like and view counts.
6. **Duplicate execution.** The entire onboarding pipeline ran twice in one session, including all
   research searches. One search query fired twice inside a single run.
7. **No provenance.** Facts are asserted flat. It listed integrations and a latency claim with no
   source. Wrong facts get baked into memory and repeated by every agent forever.
8. **Voice from a landing page.** Socials were skipped and it proceeded, inferring brand voice from
   marketing copy.
9. **Performance is optional and unused.** The whole pipeline completes with Search Console and
   Analytics skipped, and nothing degrades. Performance data is never an input to planning.

---

## 3. The thesis

**Okara compiles context once and then forgets. Build the version that remembers.**

Five non negotiable architectural commitments. Every one maps to a defect above and must be
visible in the UI, not just in the code.

- **Provenance on every fact.** No memory record exists without a source URL or an explicit
  "asserted by human" marker, plus a confidence value. The UI shows the source next to the fact.
- **Versioned memory with staleness propagation.** Records are append only. Editing supersedes
  rather than overwrites. Every artifact records which memory records it was derived from, so when
  a record is superseded, all derived artifacts are marked stale and offered for regeneration.
- **The agent set is derived from the strategy, not fixed.** The planner reads channel priorities
  and roadmap items and schedules work. Where a prioritised channel has no registered agent, it
  creates a visible **coverage gap**, rather than silently doing nothing. This is the single most
  important behavioural difference from Okara, so make it obvious in the UI.
- **Evidence, not justification.** Every draft ships with structured evidence: the memory record
  IDs used, source links, and any data points. Each is clickable and correctable. No free text
  rationale that cannot be traced.
- **Performance closes the loop.** Observations feed the planner. If nothing performed, the plan
  changes. Never display a metric that was not observed.

---

## 4. Hard rules

- **Never auto publish.** No agent may post anywhere. Publishing is a separate action requiring an
  explicit human click, and for Reddit and Hacker News the only supported flow is copy to clipboard
  plus a manual "I posted this, here is the URL" confirmation. Automated posting to those platforms
  violates their rules and would sink the whole project.
- **Never fabricate a metric, count, engagement number, or performance figure.** If it was not
  observed, show an empty state.
- **BYOK.** The model API key is supplied by the user and stored encrypted at rest, never committed,
  never logged. Support an env fallback for local development only.
- **No scraped Okara assets.** Do not copy their copy, UI, or branding. Rebuild the workflow only.
- **Every model call is logged** with prompt, model, token counts and cost, and is viewable in the UI.
- **Every job is idempotent.** A job carries an idempotency key and re-running it must not duplicate
  work. Research queries are cached and deduplicated by normalised query hash.

---

## 5. Stack

- **Next.js (App Router) with TypeScript**, React Server Components where sensible.
- **Postgres** via Neon or Supabase. **Drizzle ORM** with migrations checked in.
- **Tailwind CSS**. Dark, dense, information first. No component library beyond shadcn/ui if you want it.
- **Anthropic TypeScript SDK** for model calls. Route by task: a strong model for compilation and
  critique, a cheap fast model for routine drafting and classification. Make the mapping a single
  config object.
- **Web research:** one search provider behind a `SearchProvider` interface (Brave, Tavily or Exa).
  Always cached. Never call it twice for the same normalised query within a workspace.
- **Jobs:** a Postgres backed queue. A `jobs` table with status, attempts, locked_at and idempotency
  key, plus a worker route that claims work with `SELECT ... FOR UPDATE SKIP LOCKED`, driven by a
  cron trigger and a manual "run now" button. Do not add a third party queue service.
- **Deploy:** Vercel. It must be live on a public URL from Phase 0 onward.

---

## 6. Data model

Implement in Drizzle. Names are indicative, structure is not.

**workspaces**: id, name, domain, locales (text array, default `['en']`), created_at.

**settings**: workspace_id, encrypted_model_key, search_provider, model_config jsonb.

**sources**: id, workspace_id, url, kind (page, search_result, human), fetched_at, content_hash,
raw_text, title. Deduplicate on content_hash.

**memory_records**: id, workspace_id, type, key, value jsonb, locale, confidence (0 to 1),
status (`active` | `superseded`), version int, supersedes_id (self reference), origin
(`compiled` | `human` | `observed`), created_at.
Types: `product_fact`, `icp_segment`, `positioning`, `messaging_pillar`, `objection`, `voice_rule`,
`competitor`, `channel_priority`, `roadmap_item`.

**record_sources**: record_id, source_id, snippet, url. A record with zero rows here must render a
visible "unsourced" warning in the UI.

**research_cache**: id, workspace_id, normalised_query, query_hash (unique), provider, result jsonb,
created_at.

**agents**: registry rows, seeded in code not the database. Each declares id, channel, display name,
capabilities, what memory types it needs, estimated cost per run.

**jobs**: id, workspace_id, type, payload jsonb, idempotency_key (unique), status
(`queued` | `running` | `done` | `failed`), attempts, locked_at, reason (why the planner scheduled
this, in plain language), error, created_at, completed_at.

**agent_runs**: id, job_id, agent_id, model, prompt, tool_calls jsonb, raw_output, input_tokens,
output_tokens, cost_usd, duration_ms, created_at.

**artifacts**: id, workspace_id, channel, agent_id, kind, status (`draft` | `approved` | `rejected`
| `published` | `stale`), content text, content_final text, job_id, created_at, published_at,
external_url, locale.

**artifact_evidence**: id, artifact_id, memory_record_id (nullable), source_url (nullable),
data jsonb (nullable), note. This is both the evidence panel and the staleness graph.

**reviews**: id, artifact_id, decision (`approve` | `edit` | `reject`), reason, edit_distance,
created_at.

**observations**: id, workspace_id, artifact_id (nullable), metric, value numeric, observed_at,
source (`manual` | `gsc` | `import`). Never generated, only recorded.

**coverage_gaps**: id, workspace_id, channel, priority_rank, rationale, status
(`open` | `acknowledged`), created_at.

---

## 7. Modules

### 7.1 Ingestion
Crawl a domain: fetch sitemap or crawl to a bounded page count (default 30), extract readable text
and title, store each page as a `source`. Respect robots.txt. Cache by content hash. Show progress
in the UI as it runs.

### 7.2 Strategy compiler
A chain of model calls turning sources plus cached research into memory records. Order:
product facts, ICP segments, positioning, messaging pillars, objections, competitors (this stage
runs research queries), channel priorities, roadmap items, voice rules per locale.

Requirements:
- Every emitted record must cite at least one source id or search result URL. A record the model
  cannot source is emitted with confidence below 0.5 and flagged unsourced. Do not drop it silently.
- Structured output. Ask for strict JSON, validate with Zod, retry once on a parse failure, then
  fail the job with the raw output stored.
- Voice rules are generated per locale in the workspace. If a locale has no source material in that
  language, mark the rules low confidence and say so in the UI. Do not translate English rules and
  present them as observed.
- The whole compile is one job with one idempotency key. Re-running must supersede, not duplicate.

### 7.3 Memory viewer and editor
Browse records grouped by type. Each row shows value, confidence, locale, origin and its sources.
Editing creates a new version and supersedes the old one, keeping history viewable. Editing a record
marks all artifacts whose `artifact_evidence` references it as `stale`, with a banner offering
regeneration. This is the headline demo moment, so make it feel deliberate.

### 7.4 Planner
Runs on demand and on a schedule. Reads active channel priorities, open roadmap items, recent
observations and recent artifact history. Produces jobs, each with a plain language `reason`.

Rules:
- Prefer higher ranked channels, but avoid scheduling the same channel repeatedly if its recent
  artifacts have no observations.
- If a channel priority has no registered agent, write a `coverage_gap` instead of a job.
- Roadmap items become jobs with real status, so the roadmap is executable rather than a checklist.
- Never schedule a job whose idempotency key already exists in a non failed state.

### 7.5 Agents
One interface, several implementations:

```ts
interface ChannelAgent {
  id: string;
  channel: string;
  requiredMemory: MemoryType[];
  run(input: {
    job: Job;
    memory: MemorySlice;
    tools: AgentTools;
  }): Promise<{
    artifacts: Array<{
      kind: string;
      content: string;
      locale: string;
      evidence: EvidenceItem[];
    }>;
  }>;
}
```

Build in this order:
1. **Launch and community agent** (X, Hacker News, Product Hunt, indie communities). It searches for
   real discussions, evaluates fit against the ICP, and drafts a post or comment angle with the
   thread URL as evidence. This is first because engagement data returns within hours, which is the
   only way the feedback loop is demonstrable inside this timeframe.
2. **Content agent** (long form and comparison pages), second, to prove the contract generalises.

Every agent must return at least one evidence item per artifact. An artifact with no evidence is a
bug and should fail validation.

### 7.6 Critic
A second pass before a human sees anything. Scores a draft against active voice rules and
positioning, returns a score and specific violations. Below threshold, the draft is revised once
automatically, then surfaced with the critic's notes attached. Store critic output on the artifact.

### 7.7 Review queue
The daily surface. Each artifact shows content, its evidence panel, the critic score, the agent and
model that produced it, and the cost. Actions: approve, edit and approve, reject with a reason.

On edit, compute normalised Levenshtein distance between `content` and `content_final` and store it
on the review. Surface **average edit distance per agent over time** on a dashboard. That falling
line is the proof the system learns, so it needs to be a real chart, not a number in a corner.

### 7.8 Publishing
Approved artifacts move to a publish step. Supported flows:
- Copy to clipboard plus a manual "mark as posted" with an external URL.
- Markdown or MDX file export, and optionally a GitHub pull request for blog content.
No direct posting to social platforms in v1.

### 7.9 Performance
Two intake paths: manual entry of metrics against a published artifact, and an optional Google
Search Console read only connection. Observations feed the planner. If there are no observations,
the dashboard says so plainly rather than showing zeros that look like data.

### 7.10 Evaluation
- A golden set of 20 fixed prompts with reference outputs, runnable with `pnpm eval`, reporting
  pass rate and diffs. Run it after any prompt change.
- Voice score from the critic, tracked over time.
- Edit distance per agent, the primary internal quality metric.

### 7.11 MCP server and API
Expose the memory and the agents over a documented REST API, plus an MCP server exposing tools:
`get_memory`, `search_memory`, `list_artifacts`, `run_agent`, `record_observation`. Okara is closed
with no API and no MCP. Being open is the point, and it matches what ShogunAI itself is built on.

---

## 8. UI

Dark, dense, three panes: memory on the left, work in the centre, agents and jobs on the right.
Information first, no marketing gloss. Every screen answers "why is this here" with a traceable
link. Required screens: onboarding and compile progress, memory browser with history, review queue,
job and run inspector (prompt, tools, output, cost), coverage gaps, and a metrics dashboard.

---

## 9. Phases

**Phase 0. Scaffold.** Next.js, TypeScript, Tailwind, Drizzle, Postgres connected, deployed to
Vercel, health check page, BYOK settings screen storing an encrypted key.
*Accept:* live URL loads, key saves and round trips, migrations run clean.

**Phase 1. Schema and jobs.** All tables from section 6, plus the queue with claim, retry,
idempotency and a manual run button.
*Accept:* enqueue a no-op job from the UI, watch it claim, run and complete. Enqueueing the same
idempotency key twice creates one job.

**Phase 2. Ingestion.** Crawl a domain into sources with dedup and robots.txt respect.
*Accept:* crawl shogunaios.com, see the pages listed with content and hashes, re-crawl adds nothing.

**Phase 3. Strategy compiler.** Full chain to memory records with provenance and confidence, plus
research caching.
*Accept:* compile shogunaios.com, every record shows at least one source or an unsourced flag,
duplicate research queries hit cache, re-compiling supersedes rather than duplicates.

**Phase 4. Memory viewer, editing, staleness.** History, supersede on edit, stale propagation.
*Accept:* edit the ICP, and any artifact derived from it is marked stale with a regenerate option.

**Phase 5. Launch and community agent, critic, review queue.** End to end draft with evidence,
critic score, approve or edit or reject, edit distance recorded.
*Accept:* a draft appears with a real thread URL in evidence, editing it stores a distance, the
dashboard shows the average.

**Phase 6. Planner and coverage gaps.** Scheduling with reasons, roadmap items as jobs, gaps
surfaced for prioritised channels with no agent.
*Accept:* the planner produces jobs each with a readable reason, and Product Hunt appears as an
open coverage gap rather than being silently ignored.

**Phase 7. Publishing and performance.** Export, mark as posted, manual observations, optional GSC.
*Accept:* publish an artifact, record an observation, see the planner's next run reference it.

**Phase 8. Second agent, MCP and API.** Content agent, REST API, MCP server.
*Accept:* the second agent works without changes to the agent runner, and an MCP client can read
memory and list artifacts.

**Phase 9. Demo and docs.** Seed the ShogunAI workspace, write the README leading with the thesis
in section 3 and the evidence in section 2, plus a five minute walkthrough script.
*Accept:* a cold clone reaches a working demo from the README alone.

---

## 10. Definition of done for v1

- Point it at a domain, get a sourced memory, get drafts with evidence, approve or edit them,
  publish, record performance, and see the next plan change because of it.
- Editing a memory record visibly invalidates what came from it.
- A prioritised channel with no agent shows as a gap rather than disappearing.
- Every model call is inspectable with its cost.
- Nothing anywhere displays a number that was not observed.

Start with Phase 0. Report back when its acceptance checks pass.
