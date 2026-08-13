# 15. Known limitations and next steps

Everything the specification describes that is not implemented, every shortcut
taken, and what would come next.

---

## Not implemented

### Google Search Console

SPEC 7.9 describes "an optional Google Search Console read only connection".
**Not implemented.** No OAuth flow, no API client, no sync job. The
`observation_source` enum contains `gsc` and nothing writes it. Observations
arrive manually through `/publish` or over `POST /api/v1/observations`, which
records `source: "import"`.

### GitHub pull requests for blog content

SPEC 7.8 offers "optionally a GitHub pull request for blog content". **Not
implemented.** Markdown export exists at `/api/artifacts/{id}/export`; there is
no repository integration.

### The three-pane layout

SPEC section 8 asks for "three panes: memory on the left, work in the centre,
agents and jobs on the right". **Not implemented.** The UI is one pane per
route with a top nav. The information is all present and dense, but the layout
is not what the spec describes.

### `settings.model_config`

The column exists because SPEC section 6 names it. **Nothing writes or reads
it.** Task routing is the `MODEL_CONFIG` constant in
[`src/lib/model/index.ts`](../src/lib/model/index.ts), which cannot be changed
without a deploy.

### The `classify` task

`MODEL_CONFIG` routes a `classify` task to a cheap model. **No code path uses
it.** SPEC section 5 mentions "routine drafting and classification"; only
drafting is implemented.

### `source_kind` beyond `page`

The enum has `page`, `search_result` and `human`. Only `page` is ever written.
Search results live in `research_cache` and are cited by URL on
`record_sources`, never promoted to `sources` rows.

### Per-locale agent runs

Workspaces declare locales and voice rules compile per locale, but the planner
hard-codes `locale: "en"` on every job it schedules. Japanese voice rules are
compiled and never used.

---

## Shortcuts and their consequences

### One active memory record per key is not enforced by the database

The invariant "at most one `active` row per `(workspace_id, type, key, locale)`"
is maintained by application code in two places. Nothing stops a third write
path, a direct SQL insert, or two concurrent compiles from producing duplicates.

A partial unique index would fix it:

```sql
CREATE UNIQUE INDEX memory_records_active_uq
  ON memory_records (workspace_id, type, key, locale)
  WHERE status = 'active';
```

It is not present because `writeRecord` inserts the new row *before* superseding
the old one, so both are briefly active and the index would reject the insert.
Fixing it properly means reordering into a transaction — which the Neon HTTP
driver cannot express (see below). **This is the most significant correctness
gap in the system.**

### There are no transactions

The Neon HTTP driver runs every statement in its own implicit transaction. Three
multi-statement operations are therefore not atomic:

| Operation | Window |
|---|---|
| `writeRecord` | Insert new version → update old to superseded |
| `editRecord` | Insert → supersede → insert provenance → mark artifacts stale |
| Artifact persistence | Insert artifact → insert evidence rows |

A crash mid-sequence leaves inconsistent state: a record with two active
versions, a human edit with no provenance row, or an artifact with no evidence
despite the runner's check.

Switching to the WebSocket driver (`@neondatabase/serverless` `Pool`) would
allow real transactions and let the claim query return to the conventional
`SELECT … FOR UPDATE` + `UPDATE` shape. That is the single highest-value
refactor available.

### Derivation edges over-approximate

Every record a stage emits gets an edge to every record in that stage's
dependency slice, because the stage saw them together and cannot report which
one it actually leaned on. Editing any record in the slice therefore marks
everything the stage produced as downstream, including records that did not in
fact depend on it.

This errs toward marking too much stale rather than too little, which is the
safer direction, but it means the stale count is an upper bound. Asking the model
to name the records it used per emitted record would tighten it, at the cost of
trusting a self-report the system otherwise refuses to trust.

### A re-compile supersedes records without marking derived artifacts stale

Only `editRecord` propagates. The compiler supersedes a record whenever a stage
emits a new value for a key it has seen before, and that path never calls the
staleness walk, so a draft resting on a fact the compiler has since revised keeps
looking current.

Found while capturing screenshots for the submission document: after three
re-compiles, no draft in the queue cited a record that was still active, and
nothing in the interface said so. The evidence panel still shows `(superseded)`
against the individual citation, so the information is not lost, but the artifact
status does not move and the queue cannot be filtered by it.

Re-compiling is arguably the more common path in production — a nightly crawl
picks up a changed pricing page long before a human opens the memory editor — so
this is the propagation case that matters most. The machinery already exists;
`writeRecord` simply does not call it. See
[04-memory-semantics](04-memory-semantics.md#staleness-propagation).

### Fixtures in the capture scripts wrote through the invariant

`scripts/pairs.ts` needs two unmeasured drafts in a channel to trigger the
planner's gate, and it inserted them straight into `artifacts` rather than
through `runAgent`. That bypassed the check that every draft carries evidence,
leaving rows the review queue correctly labelled "No evidence. This should be
impossible" — one of which reached a screenshot in a draft of the submission
document before review caught it.

The script now attaches evidence like any real draft and deletes its fixtures
once the pair is captured. The general lesson holds beyond this script: an
invariant enforced in one code path is not enforced, and the database has no
constraint expressing "a draft has at least one evidence row".

### The compile summary is not persisted

`CompileSummary` — per-stage emitted, sourced, unsourced, superseded counts —
exists only in the job log as text. It cannot be queried, so "how has the
unsourced ratio moved across compiles" is unanswerable without parsing logs.

### Rate-limit state is per-process

`budgets` in [`ratelimit.ts`](../src/lib/model/ratelimit.ts) is a module-level
`Map`. It does not survive a restart and is not shared across serverless
instances, so each instance learns a limit by hitting a 429 once.

### `STALE_LOCK_MS` and `maxDuration` can conflict

Stale-lock recovery reclaims a job after five minutes. A compile takes longer
than that. If a compile is ever run through `/api/worker` with a raised
`maxDuration`, the recovery sweep will reclaim it mid-flight and run it twice
concurrently. The two constants must be kept in a fixed relationship and nothing
enforces that.

### The critic's original draft is discarded

When the critic revises below threshold, `artifacts.content` holds the *revised*
text. The pre-revision draft is not stored, so the critic's own effect cannot be
measured — only the human's, via edit distance.

### Evidence attribution is best-effort

When a model does not name the memory keys it used, the runner attributes
positioning and ICP records and labels them as runner-attributed. Honest, but it
means the evidence graph — which staleness depends on — is partly guessed.

### No pagination anywhere

`listArtifacts` caps at 100, `listSources` at 200, `listJobs` at 50,
`listObservations` at 100. There is no pagination in the UI or the API. A
workspace exceeding those limits silently sees a truncated view.

### Search keys are unencrypted

The model key is AES-256-GCM encrypted per workspace. Search keys are plain
environment variables. The asymmetry is defensible — BYOK in the spec is about
the model key — but it is an asymmetry.

### `/api/worker` is open by default

`CRON_SECRET` is optional. Unset, anyone can drain the queue. The route says so
in a comment; nothing enforces it in production.

### No authentication at all

Covered in [12 — Security](12-security.md). Worth repeating: this must not be
deployed publicly as-is.

### Testing gaps

No unit tests, no UI tests, no CI, nothing hermetic. Covered in
[13 — Testing and evaluation](13-testing-and-evaluation.md). The cost was
concrete: a query-normalisation bug that broke research deduplication survived
until an integration path made it visible.

### The chart cannot yet show a trend

The edit-distance chart is the stated proof that the system learns. With two
reviews recorded on a single day it renders two points and no line.

![The edit distance chart with two agent series on one day](images/metrics-chart.png)

Note both series sit on the same date, so there is no slope to read. The chart
is correct — it does not zero-fill or interpolate — but the claim it exists to
support needs weeks of data the system has not yet accumulated.

---

## What I would build next

In order.

### 1. Move to the WebSocket driver and get transactions

Unblocks the active-record unique index, makes `editRecord` atomic, and lets the
claim query use the conventional shape. Everything below is easier afterwards,
and the correctness gaps above mostly disappear.

### 2. Propagate staleness on re-compile, not only on human edit

`writeRecord` already knows which record it superseded and the walk it would
need is the one `editRecord` calls. This closes the propagation case that fires
most often in production and needs no new machinery.

### 3. Make the compiler resumable

Stages already commit independently. Adding a `compile_stage_runs` table and
skipping stages whose records already exist at the current source version would
turn a ten-minute all-or-nothing job into restartable work — which fixes the
serverless timeout problem properly rather than working around it.

### 4. Persist the compile summary

A `compile_runs` table with per-stage counts. Cheap, and it makes memory quality
a trend rather than an anecdote: unsourced ratio over time is the single best
indicator of whether the crawl and the prompts are improving.

### 5. Unit tests for the pure functions

`normalisedEditDistance`, `parseResetDuration`, `slugify`, `canonicalise`,
`normaliseQuery`, `extract`, `normaliseEnvelope`. All pure, all edge-case-heavy,
all currently untested. This is where the bugs have actually been.

### 6. Authentication, then multi-tenancy

Every table already carries `workspace_id`, so this is a routing and session
change rather than a migration. Auth first, because everything else is unsafe to
expose without it.

### 7. Google Search Console

The observation path exists and the planner already consumes observations. GSC
would make the loop close without a human typing numbers, which is the
difference between a demonstrable feedback loop and a used one.

### 8. Two more agents, chosen from the actual gaps

`reddit` and `linkedin` are the channels the compiler ranked and the registry
cannot serve. Writing them is a day's work each given the contract
([6](06-agents.md)), and it would demonstrate the extension path on channels the
system itself identified rather than ones chosen in advance.
