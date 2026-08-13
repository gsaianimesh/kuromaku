# 2. Architecture

## Module map

```
src/
├── app/                              Next.js App Router (all pages are server components)
│   ├── page.tsx                      Overview: health, live counts, phase list
│   ├── sources/                      Crawled pages; [id] shows extracted text
│   ├── memory/                       Records by type; [id] shows the version chain
│   ├── review/                       Review queue: content, evidence, critic, decisions
│   ├── planner/                      Priorities vs coverage, gaps, scheduled work
│   ├── publish/                      Copy-and-confirm, export, observation intake
│   ├── metrics/                      Edit distance chart, observations
│   │   └── chart.tsx                 Inline SVG line chart (client component)
│   ├── jobs/                         Queue table; [id] is the run inspector
│   ├── settings/                     BYOK key, provider, locales
│   ├── health/                       Health check UI
│   └── api/
│       ├── health/                   JSON health, 503 on failure
│       ├── worker/                   Queue drain; cron target
│       ├── artifacts/[id]/export/    Markdown export
│       ├── v1/                       REST: memory, artifacts, agents, observations
│       └── mcp/                      MCP server (JSON-RPC over HTTP)
└── lib/
    ├── db/
    │   ├── schema.ts                 Drizzle schema: 13 tables, 9 enums
    │   └── index.ts                  Lazy client with a retrying fetch
    ├── env.ts                        Zod-validated environment, lazy
    ├── crypto.ts                     AES-256-GCM envelope for BYOK keys
    ├── health.ts                     Environment, connectivity, migrations, crypto
    ├── workspace.ts                  Seed workspace, locales
    ├── settings.ts                   BYOK storage, key resolution
    ├── ingest/
    │   ├── fetch.ts                  User agent, timeouts, byte caps
    │   ├── robots.ts                 robots.txt fetch and policy
    │   ├── extract.ts                HTML → text, title, links, content hash
    │   └── crawl.ts                  Sitemap-first crawl, dedup by hash
    ├── compile/
    │   ├── stages.ts                 Nine stages: prompts, schema, normalisation
    │   └── index.ts                  The chain, provenance enforcement, supersede
    ├── memory.ts                     Read, edit, version, propagate staleness
    ├── agents/
    │   ├── registry.ts               Code-seeded agent definitions
    │   ├── types.ts                  ChannelAgent contract
    │   ├── runner.ts                 Memory slice, tools, persistence, critic
    │   ├── launch-community.ts       Community agent
    │   └── content.ts                Content agent
    ├── critic.ts                     Score, revise once, re-score
    ├── planner.ts                    Scheduling, coverage gaps
    ├── review.ts                     Decisions, edit distance, chart series
    ├── publish.ts                    Publish targets, export, observations
    ├── text.ts                       Normalised Levenshtein
    ├── model/
    │   ├── types.ts                  ModelProvider interface
    │   ├── index.ts                  Routing config, runModel, runModelJson
    │   ├── groq.ts                   Groq (OpenAI-compatible)
    │   ├── anthropic.ts              Anthropic (official SDK)
    │   ├── pricing.ts                Cost table
    │   └── ratelimit.ts              Token-bucket pacing from response headers
    ├── search/index.ts               SearchProvider + permanent cache
    ├── jobs/
    │   ├── queue.ts                  Enqueue, claim, complete, fail, recover
    │   ├── handlers.ts               Type registry with payload validation
    │   └── worker.ts                 Drain loop with caps
    └── api.ts                        Shared read/write surface for REST and MCP
```

### Dependency direction

`app/` depends on `lib/`. Nothing in `lib/` imports from `app/`. Within `lib/`,
the layering is:

```
jobs/handlers.ts ──┬──> compile/  ──┬──> model/  ──> settings.ts ──> crypto.ts
                   │                └──> search/          │
                   ├──> agents/runner ──> critic.ts ──────┘
                   └──> planner.ts ──> agents/registry.ts
                                   └──> jobs/queue.ts
```

`jobs/handlers.ts` is the single place where job types are bound to
implementations, so the worker never imports a domain module directly.

### Where the shared surface sits

[`src/lib/api.ts`](../src/lib/api.ts) exists so REST and MCP cannot drift. Both
`src/app/api/v1/*` and `src/app/api/mcp/route.ts` call the same functions; there
is no second implementation of "list artifacts" for the MCP path.

## Lifecycle 1: a compile run

```mermaid
sequenceDiagram
    participant UI as /memory
    participant A as memory/actions.ts
    participant Q as jobs/queue.ts
    participant W as jobs/worker.ts
    participant C as compile/index.ts
    participant S as search/index.ts
    participant M as model/index.ts
    participant DB as Postgres

    UI->>A: startCompileAction()
    A->>Q: enqueue(type=compile_strategy,<br/>key=compile:{workspaceId})
    Q->>DB: INSERT ... ON CONFLICT DO NOTHING
    Note over Q,DB: Partial unique index means a second<br/>click while one is queued returns<br/>the existing job
    A-->>UI: "Compile queued"

    UI->>W: runCompileNowAction()
    W->>Q: recoverStaleJobs()
    W->>Q: claimNext()
    Q->>DB: UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED)
    DB-->>W: claimed job (status=running, attempts+1)

    W->>C: compileWorkspace(workspaceId, jobId, log)
    C->>DB: SELECT * FROM sources
    Note over C: Fails immediately if there are<br/>no sources — it will not compile<br/>a memory from nothing

    loop for each of 9 stages (voice_rules once per locale)
        alt stage runs research
            C->>S: searchCached(query)
            S->>DB: SELECT FROM research_cache WHERE query_hash
            alt cache miss
                S->>S: provider.search()
                S->>DB: INSERT INTO research_cache
            end
            S-->>C: results, or unavailable reason
        end
        C->>DB: SELECT existing keys for this type+locale
        C->>M: runModelJson(stage prompt, stageOutput schema)
        M->>M: waitForBudget() if the token bucket is short
        M->>DB: INSERT INTO agent_runs (prompt, tokens, cost)
        M-->>C: validated records, or ModelJsonError

        alt validation failed after retry
            C->>C: record failure, continue to next stage
        else
            loop for each emitted record
                C->>C: resolve sourceIndices against real sources
                C->>C: resolve sourceUrls against real results
                C->>DB: INSERT memory_records (version+1, supersedes_id)
                C->>DB: UPDATE prior row SET status='superseded'
                C->>DB: INSERT record_sources (resolved citations only)
            end
            C->>DB: supersede keys that existed but were not re-emitted
        end
    end

    alt any stage failed
        C-->>W: throw (records from successful stages are kept)
        W->>Q: failJob() → retry with backoff, or failed
    else
        C-->>W: summary
        W->>Q: completeJob()
    end
```

### State at each step of a compile

| Step | Where state lives | Durable? |
|---|---|---|
| Compile requested | `jobs` row, status `queued` | Yes |
| Job claimed | same row, status `running`, `locked_at` set | Yes |
| Sources read | in memory, truncated to a 14,000-char budget | No |
| Search performed | `research_cache` row, keyed by query hash | Yes, permanently |
| Model called | `agent_runs` row with prompt, tokens, cost | Yes |
| Records emitted | `memory_records` + `record_sources` rows | Yes |
| Prior versions | same table, `status='superseded'` | Yes |
| Stage failures | accumulated in memory, thrown at the end | Surfaces on the `jobs.error` column |
| Compile finished | `jobs` row, status `done` | Yes |

Records are committed stage by stage. A compile that fails at stage seven leaves
the records from stages one to six in the database — see
[5 — The compile chain](05-compile-chain.md).

## Lifecycle 2: planner → draft → review → publish

```mermaid
sequenceDiagram
    participant P as planner.ts
    participant Q as jobs/queue.ts
    participant R as agents/runner.ts
    participant AG as agents/launch-community.ts
    participant CR as critic.ts
    participant RV as review.ts
    participant PB as publish.ts
    participant DB as Postgres

    P->>DB: SELECT channel_priority, roadmap_item (active)
    P->>DB: SELECT recent artifacts LEFT JOIN observations
    loop for each priority, ranked
        alt no agent serves this channel
            P->>DB: INSERT coverage_gaps ON CONFLICT DO UPDATE
            Note over P,DB: The gap is the output. Nothing<br/>is scheduled for this channel.
        else 2+ recent artifacts and zero observations
            P->>P: skip, with the reason recorded
        else
            P->>Q: enqueue(run_agent, key=agent:{ws}:{agent}:{channel}:{day},<br/>reason="Channel ranked N ...")
        end
    end

    Q->>R: runAgentJob(job, log)
    R->>DB: SELECT active memory for requiredMemory types
    Note over R: voice_rule is filtered to the<br/>job's locale
    R->>AG: run({ job, memory, tools })
    AG->>AG: build queries from ICP pain points
    AG->>R: tools.search(query)
    alt search unavailable
        R-->>AG: { unavailable: reason }
        Note over AG: Drafts from memory and records<br/>the reason in evidence. Does not<br/>invent a thread URL.
    end
    AG->>R: tools.completeJson(draft prompt, draftSchema)
    AG-->>R: artifacts[] with evidence[]

    R->>R: reject any artifact with zero evidence
    R->>CR: critique(content, voice rules, positioning)
    CR->>CR: score
    alt score < 0.7
        CR->>CR: revise once, then re-score
    end
    CR-->>R: { result, finalContent }
    R->>DB: INSERT artifacts (content=finalContent, critic_score, critic_notes)
    R->>DB: INSERT artifact_evidence rows

    RV->>DB: UPDATE artifacts SET status, content_final
    RV->>DB: INSERT reviews (decision, edit_distance)
    Note over RV: content is never overwritten,<br/>so distance stays recomputable

    PB->>DB: UPDATE artifacts SET status='published', external_url
    PB->>DB: INSERT observations
    Note over PB,P: The next planner run reads<br/>those observations
```

### State at each step of a draft

| Step | Where state lives | Notes |
|---|---|---|
| Planner decision | `jobs.reason`, or a `coverage_gaps` row | The reason is written at enqueue time, not derived later |
| Memory slice | in memory only | Rebuilt per run from `memory_records` |
| Search results | `research_cache` | Shared with the compiler |
| Draft text | returned from the agent, not yet stored | |
| Critic score | in memory during `critique()` | |
| Persisted artifact | `artifacts.content` = post-critic text | The critic's revision is part of `content`, not `content_final` |
| Evidence | `artifact_evidence` rows | Written in the same call as the artifact |
| Human edit | `artifacts.content_final` | `content` untouched |
| Decision | `reviews` row with `edit_distance` | `edit_distance` is null unless the decision was an edit |
| Published | `artifacts.status`, `external_url`, `published_at` | Set only by a human action |
| Performance | `observations` rows | Read by the next planner run |

## Why the critic's revision lands in `content`

`content` is what the reviewer sees and what the edit distance is measured
against. If the critic's automatic revision were stored separately, the distance
would measure the human's change *plus* the critic's, which is not the metric
the dashboard claims to show. From
[`src/lib/agents/runner.ts`](../src/lib/agents/runner.ts):

```ts
// `content` is what the agent produced, after the critic's automatic
// revision. Human edits go to contentFinal so edit distance measures
// the human's change, not the critic's.
content: finalContent,
```
