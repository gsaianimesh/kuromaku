# 5. The compile chain

Stage definitions and prompts: [`src/lib/compile/stages.ts`](../src/lib/compile/stages.ts).
Orchestration: [`src/lib/compile/index.ts`](../src/lib/compile/index.ts).
Job type: `compile_strategy`, registered in
[`src/lib/jobs/handlers.ts`](../src/lib/jobs/handlers.ts).

One compile is one job with one idempotency key, `compile:{workspaceId}`.

## Preconditions

The compiler refuses to run without sources:

```ts
if (sourceRows.length === 0) {
  throw new Error(
    "No sources to compile from. Crawl the domain first — the compiler will not invent a memory from nothing.",
  );
}
```

## The stages, in order

Nine stages. `voice_rules` runs once per workspace locale, so a workspace with
`['en','ja']` performs ten model calls.

| # | Stage | `memory_type` | Depends on | Raw page text? | Research? |
|---|---|---|---|---|---|
| 1 | `product_facts` | `product_fact` | — | Yes | No |
| 2 | `icp_segments` | `icp_segment` | product_facts | Yes | No |
| 3 | `positioning` | `positioning` | product_facts, icp_segments | No | No |
| 4 | `messaging_pillars` | `messaging_pillar` | positioning, product_facts | No | No |
| 5 | `objections` | `objection` | icp_segments, positioning | No | No |
| 6 | `competitors` | `competitor` | positioning, product_facts | No | **Yes** |
| 7 | `channel_priorities` | `channel_priority` | icp_segments, positioning | No | No |
| 8 | `roadmap_items` | `roadmap_item` | channel_priorities, messaging_pillars | No | No |
| 9 | `voice_rules` (per locale) | `voice_rule` | messaging_pillars, positioning | Yes | No |

### Why only three stages get raw page text

`needsSources` is set on `product_facts`, `icp_segments` and `voice_rules` only.
The rest reason from records already compiled.

```ts
/**
 * Whether raw page text is sent to this stage. Only the stages that read the
 * company's own words need it — the rest reason from records already
 * compiled, which is the point of a shared strategy layer and keeps each
 * prompt inside the provider's per-minute token budget.
 */
needsSources?: boolean;
```

Two reasons, both real. Architecturally, a positioning statement should be
derived from the compiled facts, not re-derived from raw HTML — that is what
makes the strategy layer shared. Practically, sending 14,000 characters of
source text to all ten calls exceeded the 8,000 tokens-per-minute limit on the
model tier in use and caused cascading rate-limit failures.

Stages without sources receive an explicit note instead:

```ts
: `\n\n(Raw page text is not supplied to this stage. Ground records in the compiled records above; cite a source index only if the record above names one.)`;
```

## Value shapes per stage

Each stage's instruction specifies the `value` payload. These are documented
here because nothing validates them beyond `z.record(z.string(), z.unknown())` —
the shape is a prompt contract, not a schema contract.

| Stage | `value` shape |
|---|---|
| `product_facts` | `{ fact, category: "capability"\|"platform"\|"pricing"\|"privacy"\|"integration"\|"other" }` |
| `icp_segments` | `{ segment, description, painPoints[], whereTheyGather[] }` |
| `positioning` | `{ statement, category, againstAlternative, differentiator }` |
| `messaging_pillars` | `{ pillar, proofPoints[], whyItMatters }` |
| `objections` | `{ objection, response, severity: "high"\|"medium"\|"low" }` |
| `competitors` | `{ name, url, positioning, overlap, differenceFromUs }` |
| `channel_priorities` | `{ channel, rank, rationale, effort }` |
| `roadmap_items` | `{ title, description, channel, horizonDays, successLooksLike }` |
| `voice_rules` | `{ rule, doExample, dontExample }` |

`channel_priorities` constrains `channel` to a fixed slug list in the prompt —
`x`, `hacker_news`, `product_hunt`, `indie_communities`, `reddit`, `seo`,
`content`, `linkedin`, `email`, `youtube` — because the planner matches those
slugs against the agent registry. A slug outside the list becomes a coverage gap
for a channel no agent will ever serve.

## Prompt assembly

Every stage prompt is `COMMON` + the stage instruction as the system message,
and a user message built from four blocks:

```
Company: {name} ({domain})
Locales in this workspace: {locales}
[locale note, for per-locale stages]

=== PREVIOUSLY COMPILED RECORDS ===
{records from dependency stages}

=== EXISTING KEYS FOR THIS TYPE ===
{keys already active for this type and locale}

=== SOURCES ===          (only when needsSources)
{numbered source blocks, truncated to a shared budget}

=== SEARCH RESULTS ===   (only for competitors)
{numbered results}
```

The `COMMON` preamble carries the rules that matter across every stage:

```
- Every record must be grounded in the supplied material. Cite the numbered
  sources you used in "sourceIndices", and any supplied search-result URLs in
  "sourceUrls".
- If you believe something is true but cannot ground it in the supplied
  material, still emit it, set "confidence" below 0.5, and leave the source
  arrays empty. Do not invent a source. Do not silently drop the record.
- "confidence" is your honest read: 0.9+ when the material states it plainly,
  0.6-0.8 when it is a fair reading, below 0.5 when it is inference.
- "snippet" must be text that actually appears in the cited source, and must
  be under 150 characters. ...
- Never invent metrics, customer counts, funding, or performance numbers.
```

### The source budget

```ts
const SOURCES_CHAR_BUDGET = 14_000;
const MIN_PER_SOURCE = 700;
const STAGE_MAX_TOKENS = 2500;
```

`renderSources` divides the budget evenly across the sources and appends
`[truncated]` to any it cut. Indices stay aligned with the `sources` array, so a
cited index still resolves correctly even when that source was truncated.

## Validation

`stageOutput` in [`src/lib/compile/stages.ts`](../src/lib/compile/stages.ts) is
the Zod schema. The specification asks for strict JSON, Zod validation, one
retry on parse failure, then failure with the raw output stored. That is what
`runModelJson` does. What the schema is *lenient* about is worth documenting,
because it is a deliberate choice.

### The envelope normaliser

Models return the same information in several shapes. Rather than spend a retry
on each, `normaliseEnvelope` accepts all of them:

| What the model returns | How it is handled |
|---|---|
| `{ records: [...] }` | The requested shape |
| A bare array | `stageOutput` preprocesses it into `{ records }` |
| `{key, value: {...}}` | The requested record shape |
| Payload flattened onto the record | Non-envelope keys are collected into `value` |
| `source_indices` / `source_urls` | Aliased to camelCase |
| `"0"` instead of `0` | `numberish` coerces |
| A bare value where a list was asked for | `listOf` wraps it |
| No `key` at all | Derived from the payload — `channel`, `name`, `title`, `segment`… then any string field |
| No `confidence` | Defaults to `0.5` |

```ts
/**
 * Deliberately lenient about shape, strict about meaning. Models routinely
 * return "0" for an index or a bare value where a list was asked for; rejecting
 * those costs a retry and changes nothing about the content. What is *not*
 * coerced is provenance — an index still has to resolve to a real source, and
 * that check lives in compile/index.ts where the sources are known.
 */
```

Key derivation matters for re-compile: a record with no key cannot supersede
anything. Deriving one from the payload keeps the version chain intact.

### Retry behaviour

`runModelJson` in [`src/lib/model/index.ts`](../src/lib/model/index.ts) makes at
most two attempts. The second includes the failed output and the specific
problem, so the model is correcting rather than guessing:

```ts
const truncated =
  response.stopReason === "length" || response.stopReason === "max_tokens";

lastProblem = truncated
  ? `the response was cut off at the ${input.maxTokens ?? 8000} token limit, so the JSON is incomplete. Return fewer records and keep every snippet under 150 characters.`
  : `not valid JSON (${e instanceof Error ? e.message : "parse error"})`;
```

Distinguishing truncation from malformed JSON was a real fix. Telling a model
"that was not valid JSON" when the actual problem was a length cut-off makes it
return the same too-long answer again.

## Failure modes

| Failure | Behaviour |
|---|---|
| No sources | Job fails immediately, before any model call |
| No model key | `NoModelKeyError` from `resolveModelKey` |
| Model returns unusable JSON twice | Stage is recorded as failed, chain continues, job fails at the end |
| Response truncated at `max_tokens` | Retry told it is a length problem; if it fails again, treated as a stage failure |
| Rate limited | `waitForBudget` pauses; 429 retried up to four times with the provider's own reset delay |
| Provider 5xx | Retried up to four times with exponential backoff |
| Search unavailable | Recorded on the summary as `researchNote`; the stage still runs, with no results |

### A stage failure does not discard the chain

```ts
/*
 * SPEC 7.2 says fail the job with the raw output stored. The raw
 * output is already on the agent_runs row, and the job does fail —
 * but at the end, not here. Throwing mid-chain would discard every
 * stage that already succeeded, and a memory that is eight-ninths
 * compiled is far more useful than none. The failure is recorded and
 * re-raised once the remaining stages have had their turn.
 */
```

Records are committed per stage, so a compile that fails at stage seven leaves
stages one to six in the database. The job ends `failed` with a message naming
every failed stage, and the raw model output is on the corresponding `agent_runs`
row.

## Re-compile behaviour

Re-running the same idempotency key is allowed because a terminal job releases
its key (see [8](08-jobs-and-queue.md)). A second compile must **supersede, not
duplicate**. Two mechanisms produce that.

### 1. Existing keys are shown to the model

```ts
const keyNote =
  existingKeys.length > 0
    ? `\n\n=== EXISTING KEYS FOR THIS TYPE ===
${existingKeys.map((k) => `- ${k}`).join("\n")}

Reuse an existing key verbatim whenever your record is about the same thing, even if you would word it differently. That is how a re-compile updates a record instead of creating a second one. Use a new key only for something genuinely not in the list.`
    : "";
```

Without this, a model picks different phrasing each run and nothing supersedes.
This was observed: an early re-compile produced 54 active records where 46 had
existed, with only 2 superseded.

### 2. A stage's output is authoritative for its type

Reusing keys is not sufficient — the model may simply omit a record it emitted
last time. If nothing handled that, the old record would stay `active` forever,
looking current.

```ts
/*
 * A stage's output is authoritative for its type and locale. Any record
 * that survived from a previous compile but was not re-emitted is
 * superseded rather than left active — otherwise a re-compile that drops
 * a fact leaves the stale one sitting in memory as though it were still
 * current, which is exactly the defect this system exists to fix.
 *
 * Nothing is deleted: the rows stay, marked superseded, and remain
 * visible in history.
 */
const emittedKeys = new Set(emitted.map((r) => r.key));
const orphans = existingKeys.filter((k) => !emittedKeys.has(k));
```

Orphans are flipped to `superseded` in one statement and logged by name.

### The guard on this behaviour

The orphan sweep runs only when `emitted.length > 0`. A stage that fails
validation emits nothing and therefore supersedes nothing — a failed stage must
not wipe the records from the last successful compile.

### Observed result

After two full compiles of the same workspace: 48 active, 52 superseded, all 52
carrying a `supersedes_id`, versions reaching 3. Active count stayed flat while
superseded grew, which is the signature of superseding rather than duplicating.

## What the summary reports

`CompileSummary` is returned by `compileWorkspace` and logged line by line to
the job. Per stage it carries `emitted`, `sourced`, `unsourced`, `superseded`,
`attempts`, and for the research stage `searches` and `cachedSearches`. The
summary is **not persisted** — it exists only in the job log. See
[15 — Known limitations](15-known-limitations.md).
