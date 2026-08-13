# 3. Data model

Schema: [`src/lib/db/schema.ts`](../src/lib/db/schema.ts). Migrations are checked
in under [`drizzle/`](../drizzle/) and applied with `npm run db:migrate`.

Thirteen tables and nine Postgres enums. `agents` is deliberately **not** a
table — the registry is seeded in code
([`src/lib/agents/registry.ts`](../src/lib/agents/registry.ts)) and artifacts
reference agents by string id with no foreign key.

## Enums

| Enum | Values |
|---|---|
| `source_kind` | `page`, `search_result`, `human` |
| `memory_type` | `product_fact`, `icp_segment`, `positioning`, `messaging_pillar`, `objection`, `voice_rule`, `competitor`, `channel_priority`, `roadmap_item` |
| `memory_status` | `active`, `superseded` |
| `memory_origin` | `compiled`, `human`, `observed` |
| `job_status` | `queued`, `running`, `done`, `failed` |
| `artifact_status` | `draft`, `approved`, `rejected`, `published`, `stale` |
| `review_decision` | `approve`, `edit`, `reject` |
| `observation_source` | `manual`, `gsc`, `import` |
| `gap_status` | `open`, `acknowledged` |

`observation_source` includes `gsc`, but no Google Search Console integration
exists. The value is reachable only by writing it directly.

## Tables

### `workspaces`

| Column | Type | Meaning |
|---|---|---|
| `id` | uuid pk | |
| `name` | text not null | Display name |
| `domain` | text not null | Crawl target |
| `locales` | text[] not null default `['en']` | Drives per-locale voice-rule compilation |
| `created_at` | timestamptz not null | |

**Invariant:** exactly one row in v1. `getOrCreateDefaultWorkspace()` returns
the first row or creates the ShogunAI seed. Nothing enforces the cardinality.

### `settings`

| Column | Type | Meaning |
|---|---|---|
| `workspace_id` | uuid pk → workspaces, cascade | One row per workspace |
| `encrypted_model_key` | text nullable | AES-256-GCM envelope, never plaintext |
| `model_provider` | text not null default `'groq'` | `groq` or `anthropic` |
| `search_provider` | text not null default `'tavily'` | `tavily`, `brave` or `exa` |
| `model_config` | jsonb not null default `{}` | Reserved; task routing currently lives in code |
| `updated_at` | timestamptz not null | |

**Invariant:** `encrypted_model_key` is either null or a base64 envelope whose
first byte is the format version. Enforced in
[`src/lib/crypto.ts`](../src/lib/crypto.ts), not by the database.

`model_config` is written by no code path. It exists because the specification
names it. Task routing is the `MODEL_CONFIG` constant in
[`src/lib/model/index.ts`](../src/lib/model/index.ts).

### `sources`

| Column | Type | Meaning |
|---|---|---|
| `id` | uuid pk | |
| `workspace_id` | uuid → workspaces, cascade | |
| `url` | text not null | Post-redirect URL actually read |
| `kind` | `source_kind` not null | Only `page` is written today |
| `title` | text nullable | og:title, then `<title>`, then first `<h1>` |
| `raw_text` | text nullable | Extracted readable text, not raw HTML |
| `content_hash` | text not null | sha256 of `title + "\n" + text` |
| `fetched_at` | timestamptz not null | |

```sql
CREATE UNIQUE INDEX "sources_workspace_hash_uq"
  ON "sources" USING btree ("workspace_id","content_hash");
```

**Database-enforced:** one row per distinct content per workspace. This is what
makes re-crawling idempotent. The crawler additionally pre-loads existing hashes
so it can *count* duplicates rather than silently swallow a conflict.

**Not enforced:** `url` is not unique. A page whose content changes produces a
second row with the same URL and a different hash. That is intentional — sources
are immutable fetch records.

### `memory_records`

| Column | Type | Meaning |
|---|---|---|
| `id` | uuid pk | |
| `workspace_id` | uuid → workspaces, cascade | |
| `type` | `memory_type` not null | |
| `key` | text not null | Stable identifier within its type; the supersede handle |
| `value` | jsonb not null | Shape varies by type, documented in [5](05-compile-chain.md) |
| `locale` | text not null default `'en'` | |
| `confidence` | real not null | 0 to 1 |
| `status` | `memory_status` not null default `'active'` | |
| `version` | integer not null default 1 | |
| `supersedes_id` | uuid nullable | Self-reference to the predecessor |
| `origin` | `memory_origin` not null | `compiled`, `human`, or `observed` |
| `created_at` | timestamptz not null | |

Indexes: `(workspace_id, type, status)` and `(workspace_id, key)`.

**Application-enforced, not database-enforced:**

- At most one `active` row per `(workspace_id, type, key, locale)`. Nothing in
  the database prevents two. The invariant holds because every write path goes
  through `writeRecord` in
  [`src/lib/compile/index.ts`](../src/lib/compile/index.ts) or `editRecord` in
  [`src/lib/memory.ts`](../src/lib/memory.ts), and both select the prior active
  row and flip it in the same operation.
- `confidence < 0.5` whenever the record has no `record_sources` rows.
- `supersedes_id` points at a row that is now `superseded`.

A unique partial index on `(workspace_id, type, key, locale) WHERE status =
'active'` would enforce the first of these in the database. It is not present —
see [15 — Known limitations](15-known-limitations.md).

**Why `supersedes_id` has no foreign key:** Drizzle self-references need an
explicit type annotation to avoid a circular inference error, and the column is
only ever written with an id the same transaction just read. The trade is
recorded here rather than hidden.

### `record_sources`

| Column | Type | Meaning |
|---|---|---|
| `id` | uuid pk | |
| `record_id` | uuid → memory_records, cascade | |
| `source_id` | uuid → sources, set null | Null for search-result and human citations |
| `url` | text nullable | |
| `snippet` | text nullable | Supporting text shown next to the fact |

**The absence of a row is the signal.** A record with zero rows here is
unsourced and renders a warning. There is deliberately no nullable placeholder
row that would hide the distinction.

### `record_derivations`

| Column | Type | Meaning |
|---|---|---|
| `id` | uuid pk | |
| `workspace_id` | uuid → workspaces, cascade | |
| `derived_record_id` | uuid → memory_records, cascade | The record a stage produced |
| `source_record_id` | uuid → memory_records, cascade | A record that was in the prompt when it was produced |
| `stage` | text not null | Which compile stage created the edge |
| `created_at` | timestamptz not null | |

```sql
CREATE UNIQUE INDEX "record_derivations_edge_uq"
  ON "record_derivations" USING btree ("derived_record_id","source_record_id");
CREATE INDEX "record_derivations_source_idx"
  ON "record_derivations" USING btree ("source_record_id");
```

**Database-enforced:** one edge per ordered pair. The compiler writes edges with
`ON CONFLICT DO NOTHING`, so a re-compile that produces the same pair is a
no-op.

**Why the second index is on `source_record_id`:** the recursive walk traverses
source to derived, so that is the direction that needs to be fast. The unique
index leads on `derived_record_id` and does not serve the walk.

**What an edge means.** A stage receives its dependency records as prompt
context and emits new records. Every emitted record gets an edge to *every*
record in that dependency slice. The stage saw them together and cannot say
which one it leaned on, so the edge set is the whole slice rather than a guess
at a subset. That over-approximates: it marks slightly more stale than strictly
necessary, which is the safer direction.

### `research_cache`

| Column | Type | Meaning |
|---|---|---|
| `id` | uuid pk | |
| `workspace_id` | uuid → workspaces, cascade | |
| `normalised_query` | text not null | Lowercased, whitespace-collapsed, terminal punctuation stripped |
| `query_hash` | text not null | sha256 of `provider + " " + normalised_query` |
| `provider` | text not null | |
| `result` | jsonb not null | The provider's results, as stored |
| `created_at` | timestamptz not null | |

```sql
CREATE UNIQUE INDEX "research_cache_hash_uq"
  ON "research_cache" USING btree ("workspace_id","query_hash");
```

**Database-enforced:** one cache entry per normalised query per workspace. The
cache has no expiry — the specification requires never calling twice for the
same query, so entries are permanent.

### `jobs`

```sql
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"locked_at" timestamp with time zone,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
```

`run_after` and `max_attempts` are additions beyond the columns the
specification lists. Retry backoff needs somewhere to record when a job becomes
runnable again, and per-job attempt limits belong on the row.

#### The partial idempotency index

This is the actual DDL, from
[`drizzle/0002_phase2_idempotency_scope.sql`](../drizzle/0002_phase2_idempotency_scope.sql):

```sql
DROP INDEX "jobs_idempotency_key_uq";
CREATE UNIQUE INDEX "jobs_idempotency_key_uq"
  ON "jobs" USING btree ("idempotency_key")
  WHERE status in ('queued', 'running');
```

It is partial by design. A terminal row releases its key, because re-running is
required behaviour: re-compiling must supersede rather than duplicate, and
re-crawling must be possible. What this does and does not guarantee is spelled
out in [8 — Jobs and the queue](08-jobs-and-queue.md).

#### The claim query

From [`src/lib/jobs/queue.ts`](../src/lib/jobs/queue.ts). The select is nested
inside the update because the Neon HTTP driver runs each statement in its own
implicit transaction — a standalone `SELECT ... FOR UPDATE SKIP LOCKED` would
release its lock before the follow-up UPDATE ran.

```sql
UPDATE jobs
SET status = 'running',
    locked_at = now(),
    attempts = attempts + 1
WHERE id = (
  SELECT id FROM jobs
  WHERE status = 'queued' AND run_after <= now()
  ORDER BY run_after ASC, created_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING *;
```

Index supporting it: `jobs_claim_idx` on `(status, run_after, created_at)`.

### `agent_runs`

| Column | Type | Meaning |
|---|---|---|
| `id` | uuid pk | |
| `job_id` | uuid → jobs, **set null**, nullable | Detaches rather than cascading |
| `job_type` | text nullable | Kept verbatim so a detached run still says what it belonged to |
| `agent_id` | text not null | e.g. `compiler:product_facts`, `launch_community:critic` |
| `model` | text not null | The model actually served |
| `prompt` | text nullable | System and user turns, concatenated |
| `tool_calls` | jsonb nullable | `{ task, stopReason }`, or `{ task, failed: true }` |
| `raw_output` | text nullable | Response text, or `ERROR: …` on failure |
| `input_tokens`, `output_tokens` | integer nullable | As reported by the provider |
| `cost_usd` | numeric(12,6) nullable | **Null means unpriced, not free** |
| `duration_ms` | integer nullable | |
| `created_at` | timestamptz not null | |

**This used to cascade, and that was a data-loss hazard.** Deleting a job
destroyed its model-call audit trail; a cleanup during development silently
removed 19 of 22 `agent_runs` rows and with them the only record of what those
calls cost. `job_id` is now nullable with `ON DELETE SET NULL`, and `job_type`
carries the job's type on the row so a detached run still says what it belonged
to. An audit trail that disappears when the thing it audits is tidied away is
not an audit trail.

```sql
ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_job_id_jobs_id_fk";
ALTER TABLE "agent_runs" ALTER COLUMN "job_id" DROP NOT NULL;
ALTER TABLE "agent_runs" ADD COLUMN "job_type" text;
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_job_id_jobs_id_fk"
  FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null;
```

### `artifacts`

| Column | Type | Meaning |
|---|---|---|
| `id` | uuid pk | |
| `workspace_id` | uuid → workspaces, cascade | |
| `channel` | text not null | Channel slug |
| `agent_id` | text not null | No FK — the registry is code |
| `kind` | text not null | `post`, `comment_angle`, `long_form`, `comparison_page` |
| `status` | `artifact_status` not null default `'draft'` | |
| `content` | text not null | As produced, after the critic's revision. **Never overwritten.** |
| `content_final` | text nullable | After a human edit |
| `critic_score` | real nullable | |
| `critic_notes` | jsonb nullable | `{ violations, strengths, revisedAutomatically, threshold }` |
| `job_id` | uuid → jobs, set null | |
| `locale` | text not null default `'en'` | |
| `external_url` | text nullable | Set only by `markAsPosted` |
| `created_at`, `published_at` | timestamptz | |

**Invariant, application-enforced:** `external_url` and `published_at` are
non-null only when `status = 'published'`, and that transition requires
`status = 'approved'` first.

**`content` is never overwritten** so that
`normalisedEditDistance(content, content_final)` stays recomputable from stored
data at any later time.

### `artifact_evidence`

| Column | Type | Meaning |
|---|---|---|
| `id` | uuid pk | |
| `artifact_id` | uuid → artifacts, cascade | |
| `memory_record_id` | uuid → memory_records, **set null** | |
| `source_url` | text nullable | |
| `data` | jsonb nullable | Observed data points only |
| `note` | text nullable | Human-readable description |

Indexed on both `artifact_id` and `memory_record_id`. The second index exists
because this table is walked in the staleness direction as well as the display
direction.

**`ON DELETE SET NULL` on `memory_record_id` is deliberate:** if a memory record
were ever hard-deleted, the evidence row survives with its `note` intact, so the
artifact still shows *something* was cited rather than the row vanishing.

**Application-enforced:** every artifact has at least one evidence row. The
runner throws before persisting an artifact with none:

```ts
if (draft.evidence.length === 0) {
  throw new Error(
    `Agent "${agentId}" returned an artifact with no evidence. ...`,
  );
}
```

Nothing in the database enforces this. A row inserted directly can have no
evidence, which is exactly what happened with test fixtures during development.

### `reviews`

| Column | Type | Meaning |
|---|---|---|
| `id` | uuid pk | |
| `artifact_id` | uuid → artifacts, cascade | |
| `decision` | `review_decision` not null | |
| `reason` | text nullable | Required by application code for `reject` |
| `edit_distance` | real nullable | Null unless the decision was `edit` |
| `created_at` | timestamptz not null | |

**Application-enforced:** a `reject` without a reason throws. An `edit` always
carries a distance; an `approve` never does — an approval with a `0.0` distance
would be indistinguishable from an edit that changed nothing.

### `observations`

| Column | Type | Meaning |
|---|---|---|
| `id` | uuid pk | |
| `workspace_id` | uuid → workspaces, cascade | |
| `artifact_id` | uuid → artifacts, cascade, nullable | Null allows workspace-level metrics |
| `metric` | text not null | Lowercased and trimmed on write |
| `value` | numeric(20,4) not null | |
| `source` | `observation_source` not null | |
| `observed_at` | timestamptz not null | |

**Only ever inserted.** No code path updates or derives an observation.

### `coverage_gaps`

| Column | Type | Meaning |
|---|---|---|
| `id` | uuid pk | |
| `workspace_id` | uuid → workspaces, cascade | |
| `channel` | text not null | |
| `priority_rank` | integer nullable | Rank from the compiled priority |
| `rationale` | text nullable | Generated sentence explaining the gap |
| `status` | `gap_status` not null default `'open'` | |
| `created_at` | timestamptz not null | |

```sql
CREATE UNIQUE INDEX "coverage_gaps_workspace_channel_uq"
  ON "coverage_gaps" USING btree ("workspace_id","channel");
```

**Database-enforced:** one gap row per channel per workspace. The planner uses
`ON CONFLICT DO UPDATE` so repeated runs refresh the rank and rationale rather
than accumulating duplicates. An `acknowledged` gap that is still uncovered will
have its rationale updated but keeps its status, because the update statement
does not touch `status`.

## Relationship summary

```
workspaces 1─┬─* sources ────────────* record_sources *─────1 memory_records
             │                                                    │ 1
             ├─1 settings                                          │ *
             ├─* research_cache                          artifact_evidence
             ├─* memory_records ──self-ref supersedes_id           * │
             ├─* coverage_gaps                                       │ 1
             ├─* observations *────────────────1 artifacts ──────────┘
             └─* jobs 1─┬─* agent_runs
                        └─* artifacts (set null)
                                │ 1
                                └─* reviews
```

## Enforcement split, and why

| Invariant | Where | Reason |
|---|---|---|
| One source per content hash per workspace | Database | Concurrency-safe; two crawlers must not both insert |
| One research cache entry per query | Database | Same |
| One job per idempotency key while active | Database | The whole point is preventing a race |
| One gap per channel | Database | Planner runs may overlap |
| One active memory record per type/key/locale | Application | See [15](15-known-limitations.md) — this one should move to the database |
| Unsourced ⇒ confidence < 0.5 | Application | Depends on a count over another table; a CHECK cannot express it |
| Every artifact has evidence | Application | Same — cross-table |
| Published ⇒ was approved | Application | A state-transition rule, not a row predicate |
| Reject requires a reason | Application | Conditional on an enum value; expressible as a CHECK, not written as one |
