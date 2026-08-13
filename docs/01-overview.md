# 1. Overview

## What the system does

Kuromaku crawls a company's website, compiles the extracted text into a set of
versioned records called a *memory*, and runs channel agents that draft
marketing work from that memory. Drafts go to a human for approval. Published
work accumulates observations, and those observations feed back into what gets
scheduled next.

Concretely, the system can:

- Crawl a domain into deduplicated page records
  ([`src/lib/ingest/crawl.ts`](../src/lib/ingest/crawl.ts))
- Compile those pages into nine types of memory record, each carrying a source
  citation or an explicit unsourced flag
  ([`src/lib/compile/index.ts`](../src/lib/compile/index.ts))
- Let a human edit any record, which creates a new version and marks every
  artifact derived from the old one as stale
  ([`src/lib/memory.ts`](../src/lib/memory.ts))
- Compare compiled channel priorities against a code-seeded agent registry and
  record a *coverage gap* where no agent can serve a prioritised channel
  ([`src/lib/planner.ts`](../src/lib/planner.ts))
- Run agents that draft for a channel and attach structured evidence to every
  draft ([`src/lib/agents/`](../src/lib/agents/))
- Score each draft against compiled voice rules before a human sees it, and
  revise it once automatically if it scores below threshold
  ([`src/lib/critic.ts`](../src/lib/critic.ts))
- Record approve / edit / reject decisions and compute normalised edit distance
  on edits ([`src/lib/review.ts`](../src/lib/review.ts))
- Export approved work, accept a manual "I posted this" confirmation, and record
  observed metrics against it ([`src/lib/publish.ts`](../src/lib/publish.ts))
- Expose memory, artifacts, agents and observations over REST and MCP
  ([`src/lib/api.ts`](../src/lib/api.ts))

## What the system explicitly does not do

These are enforced, not merely unimplemented.

**It does not publish anything.** No code path in the repository makes an
authenticated write to X, Hacker News, Reddit, Product Hunt or any other
platform. `markAsPosted` in
[`src/lib/publish.ts`](../src/lib/publish.ts) only records a URL a human
supplies, and it rejects any artifact that is not already `approved`:

```ts
if (artifact.status !== "approved") {
  throw new Error(
    `Only an approved artifact can be marked as posted. This one is ${artifact.status}.`,
  );
}
```

**It does not display an unmeasured number.** Where no observation exists the UI
renders an empty state that says so. A model with no entry in the pricing table
produces a `null` cost that renders as `unpriced`, never `$0.00`
([`src/lib/model/pricing.ts`](../src/lib/model/pricing.ts)).

**It does not assert a fact without provenance.** A record the compiler cannot
ground is still written, but with no `record_sources` rows and a confidence
capped below 0.5. The UI renders it with a warning. See
[4 — Memory semantics](04-memory-semantics.md).

**It does not authenticate users.** v1 is single-tenant and has no login. Every
table carries `workspace_id`, so multi-tenancy is a routing change rather than a
migration, but no such routing exists.

## The v1 scope boundary

| In scope | Out of scope |
|---|---|
| One workspace, no auth | Multi-tenant, roles, sessions |
| Crawling a public site over HTTP | Authenticated crawling, JS rendering |
| Two channel agents (community, content) | The eight other channels the compiler can prioritise |
| Manual observation entry, and an import endpoint | Google Search Console or any analytics integration |
| Markdown export and copy-to-clipboard | GitHub pull requests for blog content |
| Groq and Anthropic behind one interface | Any other model provider |
| Tavily, Brave and Exa behind one interface | Any other search provider |

Google Search Console is described in the specification as an optional intake
path. It is **not implemented** — see
[15 — Known limitations](15-known-limitations.md).

## Glossary

**Source** — one fetched page, stored with its URL, extracted readable text, and
a SHA-256 hash of that text. Deduplicated on `(workspace_id, content_hash)`, so
re-crawling an unchanged page stores nothing. Table: `sources`.

**Memory record** — one compiled or human-asserted fact, of one of nine types
(`product_fact`, `icp_segment`, `positioning`, `messaging_pillar`, `objection`,
`competitor`, `channel_priority`, `roadmap_item`, `voice_rule`). Carries a
`value` payload, a `confidence` between 0 and 1, a `locale`, an `origin`
(`compiled` / `human` / `observed`), and a `version`. Records are append-only:
an edit inserts a new row and flips the old one to `superseded`. Table:
`memory_records`.

**Provenance** — the link between a memory record and what grounds it. Stored as
rows in `record_sources`, each pointing at a `source` row, a URL, or both, with
an optional snippet. A record with zero such rows is *unsourced*.

**Unsourced** — a memory record with no `record_sources` rows. It is not an
error and is not discarded; it is a claim the compiler could not ground.
Confidence is capped below 0.5 at write time regardless of what the model
claimed, and the UI renders a warning.

**Artifact** — one drafted piece of work for one channel: a post, a comment
angle, a long-form article, a comparison page. Carries the agent that produced
it, the critic score, the original `content`, and — after a human edit —
`content_final`. `content` is never overwritten, so edit distance stays
computable. Table: `artifacts`.

**Evidence** — the structured record of what an artifact was derived from: a
memory record id, a source URL, a data point, or a note. Stored in
`artifact_evidence`. It serves two purposes at once: it is the panel a reviewer
reads, and it is the graph staleness propagates through.

**Staleness** — the state an artifact enters when a memory record its evidence
cites is superseded. Computed at edit time by walking `artifact_evidence`, not
by a background scan. A `published` artifact is deliberately left published; see
[4 — Memory semantics](04-memory-semantics.md).

**Coverage gap** — a channel that appears in the compiled `channel_priority`
records but that no agent in the code-seeded registry serves. Recorded as a row
in `coverage_gaps` with the priority rank and a rationale, rather than being
silently skipped.

**Observation** — one measured performance figure against a published artifact:
a metric name, a numeric value, a timestamp, and a source (`manual`, `gsc`,
`import`). Only ever recorded, never generated. Table: `observations`.

**Job** — one unit of queued work with a type, a JSON payload, an idempotency
key, a status, and a plain-language `reason` explaining why it was scheduled.
Table: `jobs`.

**Agent run** — one model call, logged with its prompt, model id, token counts,
cost and duration. Attached to the job that made it. Table: `agent_runs`.
