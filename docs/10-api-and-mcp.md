# 10. API and MCP reference

Shared implementation: [`src/lib/api.ts`](../src/lib/api.ts). REST routes under
[`src/app/api/v1/`](../src/app/api/v1/); MCP at
[`src/app/api/mcp/route.ts`](../src/app/api/mcp/route.ts).

Both surfaces call the same functions, so they cannot drift.

**No authentication.** Every endpoint operates on the default workspace via
`getOrCreateDefaultWorkspace()`. See [12 — Security](12-security.md).

Examples assume `http://localhost:3000`.

---

## REST

### `GET /api/v1/memory`

Active memory records with their provenance.

| Query param | Meaning |
|---|---|
| `type` | Filter by `memory_type` |
| `locale` | Filter by locale |
| `q` | Full-text search over key and value; overrides `type` and `locale` |
| `limit` | Only with `q`; default 20 |

```bash
curl 'localhost:3000/api/v1/memory?type=positioning'
```

```json
{
  "workspace": {
    "id": "5accae51-ba18-4e43-b602-f9be17bc178c",
    "name": "ShogunAI",
    "domain": "shogunaios.com"
  },
  "count": 3,
  "unsourced": 3,
  "records": [
    {
      "id": "6947b55b-9f8f-4272-bd75-2ba4a1d7d680",
      "type": "positioning",
      "key": "free-access-vs-paid-ai-assistants",
      "value": {
        "category": "pricing",
        "statement": "ShogunAI offers early-access with no credit card required…"
      },
      "locale": "en",
      "confidence": 0.4,
      "version": 1,
      "origin": "compiled",
      "unsourced": true,
      "sources": []
    }
  ]
}
```

Every record carries `unsourced` and its `sources`. The envelope reports
`unsourced` as a count so a consumer can see the proportion without iterating.

### `GET /api/v1/artifacts`

| Query param | Meaning |
|---|---|
| `status` | `draft`, `approved`, `rejected`, `published`, `stale` |

```bash
curl 'localhost:3000/api/v1/artifacts?status=stale'
```

```json
{
  "count": 1,
  "artifacts": [
    {
      "id": "a94c8e16-…",
      "channel": "product_hunt",
      "agentId": "launch_community",
      "kind": "post",
      "status": "stale",
      "locale": "en",
      "criticScore": 0.7,
      "content": "…",
      "externalUrl": null,
      "createdAt": "2026-08-13T…",
      "publishedAt": null,
      "evidence": [
        {
          "memoryRecordId": "e0a05650-…",
          "recordKey": "founders",
          "sourceUrl": null,
          "note": "icp_segment: founders",
          "superseded": true
        }
      ],
      "observationCount": 0
    }
  ]
}
```

`content` is `content_final ?? content` — the edited text when one exists.
`superseded: true` on an evidence item is why the artifact is stale.

### `GET /api/v1/agents`

The code-seeded registry.

```bash
curl localhost:3000/api/v1/agents
```

```json
{
  "agents": [
    {
      "id": "launch_community",
      "displayName": "Launch and community agent",
      "channels": ["x", "hacker_news", "product_hunt", "indie_communities"],
      "description": "Finds real discussions, evaluates fit against the ICP, …",
      "capabilities": ["discussion_search", "post_draft", "comment_angle"],
      "requiredMemory": ["icp_segment", "positioning", "messaging_pillar", "voice_rule", "product_fact"],
      "estimatedCostUsd": 0.02
    }
  ]
}
```

### `POST /api/v1/agents`

Queues an agent run. Returns `202` when a job was created, `200` when an
equivalent job already existed.

```json
{ "agentId": "launch_community", "channel": "hacker_news", "locale": "en" }
```

```bash
curl -X POST localhost:3000/api/v1/agents \
  -H 'content-type: application/json' \
  -d '{"agentId":"launch_community","channel":"hacker_news"}'
```

```json
{
  "jobId": "8f2c…",
  "created": true,
  "reason": "Requested over the API."
}
```

`channel` defaults to the agent's first channel. A channel the agent does not
serve is a `400`:

```json
{ "error": "Agent \"content\" does not serve channel \"x\". It serves: content, seo" }
```

**This does not run the agent.** It enqueues a job; the worker or the "Run
queued work" button executes it. Nothing is published either way.

### `GET /api/v1/observations`

```json
{
  "count": 1,
  "observations": [
    {
      "id": "…",
      "metric": "upvotes",
      "value": 42,
      "source": "manual",
      "observedAt": "2026-08-13T…",
      "artifactId": "e26a59a9-…",
      "channel": "hacker_news"
    }
  ]
}
```

### `POST /api/v1/observations`

```json
{ "artifactId": "e26a59a9-…", "metric": "upvotes", "value": 42 }
```

```bash
curl -X POST localhost:3000/api/v1/observations \
  -H 'content-type: application/json' \
  -d '{"artifactId":"e26a59a9-…","metric":"upvotes","value":42}'
```

Returns `201` with `{"ok": true}`. Recorded with `source: "import"` — the manual
UI path uses `source: "manual"`, so the two are distinguishable afterwards.

Validation is Zod: `artifactId` must be a uuid, `value` must be a number. A
string value is a `400`, not a coerced zero.

### `GET /api/artifacts/{id}/export`

Markdown with YAML front matter, as a download.

```bash
curl -OJ localhost:3000/api/artifacts/e26a59a9-…/export
```

```markdown
---
channel: hacker_news
kind: post
agent: launch_community
locale: en
status: published
created_at: 2026-08-13T…
critic_score: 0.95
---

You spend a lot of time switching between tools…
```

Filename is `{YYYY-MM-DD}-{slug}.md`, slug derived from the first line.

### `GET /api/health`

Environment, database connectivity, migration state, encryption round trip.
Returns `503` if any check fails.

```json
{
  "status": "pass",
  "checkedAt": "2026-08-13T…",
  "checks": [
    { "id": "env", "label": "Environment variables", "status": "pass", "detail": "…" },
    { "id": "db", "label": "Database connection", "status": "pass", "detail": "PostgreSQL 18.4", "durationMs": 306 },
    { "id": "migrations", "label": "Migrations", "status": "pass", "detail": "3 applied · 13/13 expected tables present", "durationMs": 707 },
    { "id": "crypto", "label": "Encryption round trip", "status": "pass", "detail": "…" }
  ]
}
```

### `GET|POST /api/worker`

Drains the queue. `?maxJobs=N` caps the batch. Requires
`Authorization: Bearer {CRON_SECRET}` when that variable is set; open when it is
not.

```json
{
  "recovered": 0,
  "processed": [
    { "jobId": "…", "type": "run_agent", "outcome": "done", "durationMs": 41230, "log": ["…"] }
  ],
  "hitLimit": false,
  "elapsedMs": 41890
}
```

`outcome` is `done`, `retrying` or `failed`.

---

## MCP

`POST /api/mcp` speaks JSON-RPC 2.0 over Streamable HTTP. Protocol version
`2025-06-18`. Implemented directly rather than through an SDK — the surface is
three methods, and the tool bodies are the same `api.ts` functions the REST
routes call.

`GET /api/mcp` returns a manifest, which makes the endpoint discoverable:

```json
{
  "server": { "name": "kuromaku", "version": "0.1.0" },
  "protocolVersion": "2025-06-18",
  "transport": "streamable-http",
  "endpoint": "/api/mcp",
  "tools": [{ "name": "get_memory", "description": "…" }]
}
```

Client configuration:

```json
{ "mcpServers": { "kuromaku": { "url": "http://localhost:3000/api/mcp" } } }
```

### Supported methods

| Method | Behaviour |
|---|---|
| `initialize` | Returns protocol version, `capabilities: { tools: {} }`, server info |
| `notifications/initialized` | Accepted, no response (it is a notification) |
| `ping` | `{}` |
| `tools/list` | All six tools with JSON Schema |
| `tools/call` | Dispatches by `params.name` |

Batch requests are supported: an array in produces an array out. A batch
containing only notifications returns `202` with no body.

Errors use standard codes: `-32700` parse error, `-32601` method not found,
`-32602` invalid params, `-32603` internal error.

### Tools

Tool results are content blocks. JSON is returned in a text block:

```ts
function textResult(payload: unknown, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError,
  };
}
```

Tool-level failures return `isError: true` inside a successful JSON-RPC
response, rather than a protocol error — the model needs to read the message.

#### `get_memory`

`{ type?, locale? }` — the active memory.

```bash
curl -X POST localhost:3000/api/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"get_memory","arguments":{"type":"channel_priority"}}}'
```

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [{ "type": "text", "text": "{\n \"count\": 6,\n \"unsourced\": 6,\n \"records\": [ … ]\n}" }],
    "isError": false
  }
}
```

Verified live: this returned six channel priorities with `hacker_news` at rank 1.

#### `search_memory`

`{ query, limit? }` — full-text over key and value.

#### `list_artifacts`

`{ status? }` — drafts and published work with evidence. Evidence items marked
`superseded` mean the memory that artifact was derived from has changed.

#### `run_agent`

`{ agentId, channel?, locale? }` — queues a run. The description states the
constraint the caller needs to know:

> This never publishes anything — the draft lands in the review queue for a
> human. Returns a job id.

The result adds a note repeating it:

```json
{ "jobId": "…", "created": true, "reason": "Requested over the API.",
  "note": "Queued. Nothing is published — the draft goes to the review queue." }
```

#### `record_observation`

`{ artifactId, metric, value }`. The description carries the rule:

> Only record what was actually observed — this system never displays a metric
> it did not measure.

#### `list_coverage_gaps`

No arguments. Prioritised channels with no registered agent.

```json
{ "gaps": [
  { "channel": "reddit", "priorityRank": 4, "rationale": "Ranked 4 in the strategy…", "status": "open" },
  { "channel": "linkedin", "priorityRank": 5, "rationale": "Ranked 5 in the strategy…", "status": "open" }
]}
```

### Tool descriptions carry the invariants

Descriptions are written for a model rather than a developer, and state the
properties a caller must not assume away — for example on `get_memory`:

> Every record carries its sources and an `unsourced` flag; a record with no
> sources is an unverified inference, not a fact.

---

## What is not exposed

| Not available | Where it exists |
|---|---|
| Editing a memory record | UI only (`/memory`) |
| Approving, editing or rejecting an artifact | UI only (`/review`) |
| Marking as posted | UI only (`/publish`) |
| Triggering a crawl or compile | UI only |
| Running the planner | UI only, or the cron |
| Listing jobs or agent runs | UI only |

The read surface is broad; the write surface is deliberately three endpoints
(`run_agent`, `record_observation`, and the worker). Approval and publishing are
human actions and have no API.
