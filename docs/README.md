# Engineering documentation

Written from the code, not from the specification. Where the spec describes
something that is not implemented, it appears in
[15 — Known limitations](15-known-limitations.md) as not implemented, and
nowhere else.

| # | Document | What it covers |
|---|---|---|
| 1 | [Overview](01-overview.md) | What the system does and does not do, the v1 boundary, glossary |
| 2 | [Architecture](02-architecture.md) | Module map, the two lifecycles, where state lives |
| 3 | [Data model](03-data-model.md) | Every table and column, invariants, DDL |
| 4 | [Memory semantics](04-memory-semantics.md) | Versioning, supersede, staleness, provenance enforcement |
| 5 | [The compile chain](05-compile-chain.md) | Stages, prompts, validation, re-compile behaviour |
| 6 | [Agents](06-agents.md) | Contract, registry, runner, critic, adding an agent |
| 7 | [Planner](07-planner.md) | Scheduling rules, reasons, coverage gaps |
| 8 | [Jobs and the queue](08-jobs-and-queue.md) | Claim semantics, idempotency, retries, worker |
| 9 | [Model layer](09-model-layer.md) | Provider seam, routing, rate limits, cost |
| 10 | [API and MCP](10-api-and-mcp.md) | Every endpoint and tool |
| 11 | [Configuration and deployment](11-configuration-and-deployment.md) | Env, setup, deploy, cron |
| 12 | [Security](12-security.md) | Key encryption, secret handling, publish enforcement |
| 13 | [Testing and evaluation](13-testing-and-evaluation.md) | verify, e2e, eval, and coverage gaps |
| 14 | [Runbook](14-runbook.md) | Tracing a bad draft, debugging jobs, failure modes |
| 15 | [Known limitations](15-known-limitations.md) | Unimplemented, shortcuts, next steps |

## Screenshots

Every image under [images/](images/) is captured from the running application
against the real database by [scripts/screenshots.ts](../scripts/screenshots.ts).
Nothing is mocked. The script fails rather than capturing a page whose expected
content is absent, and it aborts if a full API key would be legible in a shot.

Regenerate them:

```bash
npm run dev          # terminal 1
npm run screenshots  # terminal 2
```
