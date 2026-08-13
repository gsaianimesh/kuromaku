# 6. Agents

Contract: [`src/lib/agents/types.ts`](../src/lib/agents/types.ts).
Registry: [`src/lib/agents/registry.ts`](../src/lib/agents/registry.ts).
Runner: [`src/lib/agents/runner.ts`](../src/lib/agents/runner.ts).
Critic: [`src/lib/critic.ts`](../src/lib/critic.ts).

## The contract

```ts
export interface ChannelAgent {
  id: string;
  channel: string;
  requiredMemory: MemoryType[];
  run(input: {
    job: Job;
    memory: MemorySlice;
    tools: AgentTools;
  }): Promise<{ artifacts: DraftedArtifact[] }>;
}
```

An agent receives a memory slice and a tool bundle, and returns artifacts. It
does not touch the database, does not call a model directly, does not decide
whether it should run, and does not persist anything. Everything an agent needs
comes through `tools`:

```ts
export type AgentTools = {
  search: (query: string) => Promise<SearchOutcome>;
  complete: (input: { task; system; user; maxTokens? }) => Promise<string>;
  completeJson: <T>(input: {...}, schema: ZodType<T>) => Promise<T>;
  log: (message: string) => void;
};
```

`tools.complete` and `tools.completeJson` route through `runModel` /
`runModelJson`, which means every call an agent makes is logged to `agent_runs`
with its cost. An agent cannot make an unlogged model call without importing the
model layer directly, which no agent does.

### The evidence requirement

```ts
export type DraftedArtifact = {
  kind: string;
  channel: string;
  content: string;
  locale: string;
  /** SPEC 7.5: at least one item, or the artifact fails validation. */
  evidence: EvidenceItem[];
};
```

An `EvidenceItem` carries at least a `note`, and optionally a
`memoryRecordId`, a `sourceUrl`, and observed `data`. The runner rejects an
artifact with none:

```ts
if (draft.evidence.length === 0) {
  throw new Error(
    `Agent "${agentId}" returned an artifact with no evidence. Every draft must carry the memory records and links it rests on.`,
  );
}
```

This throws before persistence, so the artifact is never written.

![An evidence panel listing record keys as links plus a note](images/review-evidence.png)

Note that each entry is a link — memory record ids resolve to `/memory/<id>`,
URLs open the actual page — and the trailing note explains what the item is.

## The registry

Seeded in code, not the database:

```ts
export const AGENTS: AgentDefinition[] = [
  {
    id: "launch_community",
    channels: ["x", "hacker_news", "product_hunt", "indie_communities"],
    displayName: "Launch and community agent",
    description: "Finds real discussions, evaluates fit against the ICP, and drafts a post or comment angle with the thread URL as evidence.",
    capabilities: ["discussion_search", "post_draft", "comment_angle"],
    requiredMemory: ["icp_segment", "positioning", "messaging_pillar", "voice_rule", "product_fact"],
    estimatedCostUsd: 0.02,
  },
  {
    id: "content",
    channels: ["content", "seo"],
    ...
  },
];
```

Two agents covering six channels. The compiler can prioritise ten. **The gap is
the point** — the registry comment says so:

```ts
/**
 * This list is deliberately shorter than the channel list the compiler can
 * produce. That mismatch is the point: a prioritised channel with no agent here
 * becomes a visible coverage gap instead of silently doing nothing, which is
 * the single most important behavioural difference from Okara (SPEC section 3).
 */
```

`estimatedCostUsd` is a hand-entered constant, not a measurement. It is surfaced
on `/planner` as `~$0.02/run`. Actual per-run cost is on the job inspector.

## The runner

`runAgentJob` does six things in order.

**1. Resolve the agent.** Both the definition and the implementation must exist:

```ts
const definition = agentById(agentId);
const implementation = agentImplementation(agentId);
if (!definition || !implementation) {
  throw new Error(
    `No agent registered with id "${agentId}". Registered: ${Object.keys(IMPLEMENTATIONS).join(", ")}`,
  );
}
```

**2. Build the memory slice**, filtered to the types the agent declared. Voice
rules are additionally filtered to the job's locale:

```ts
byType[type] = all.filter(
  (r) => r.type === type && (type !== "voice_rule" || r.locale === locale),
);
```

Missing types are logged but do not block the run — an agent decides for itself
whether it can proceed, which the community agent does:

```ts
if (icp.length === 0 || positioning.length === 0) {
  throw new Error(
    "Cannot draft without ICP segments and positioning in memory. Compile the strategy first.",
  );
}
```

**3. Run the agent.**

**4. Validate evidence**, per artifact.

**5. Critique**, per artifact.

**6. Persist** the artifact and its evidence rows.

## The critic loop

```
draft ──> score ──┬── >= 0.7 ──> store, revised: false
                  │
                  └── < 0.7 ───> revise once ──> re-score ──> store, revised: true
```

Threshold is `CRITIC_THRESHOLD = 0.7` in
[`src/lib/critic.ts`](../src/lib/critic.ts).

The critic is prompted against the compiled voice rules and positioning, and is
told to flag anything reading as an unsupported metric:

```
Judge only what is written. Do not reward or penalise length. Flag any claim
that reads as a metric, benchmark, or customer count — those must not appear
unless the positioning or a product fact supports them.
```

Below threshold, the revision prompt receives the specific violations and the
strengths to preserve, and is told not to add anything:

```
Fix only what is listed. Keep everything the reviewer called a strength. Do not
add claims, metrics, or examples that were not already present.
```

**The re-score is not cosmetic.** After revising, the critic scores the revised
text and *that* score is stored, so `critic_score` always describes the content
the reviewer is looking at. The cost is a third model call on any draft that
falls below threshold.

![Critic panel showing a named violation about an exaggerated adjective](images/review-critic.png)

Note the violation is specific — it names the rule (`avoid-exaggerated-adjectives`),
quotes the offending phrase, and carries a severity. The critic notes are stored
as jsonb on the artifact, so this panel is reading persisted data, not
re-running the critic.

## Degradation when search is unavailable

The community agent searches for real discussions. When no search provider is
configured it must not invent a thread URL. It drafts from memory and records
the reason:

```ts
if (searchNote) {
  evidence.push({
    note: `No discussion search was possible: ${searchNote} This draft rests on compiled memory alone and cites no thread.`,
  });
}
```

The absence of a thread citation is therefore visible in the evidence panel
rather than silent.

## Attribution fallback

Agents ask the model which memory keys it used, and the model sometimes returns
none. Rather than fail the artifact, the runner attributes the records that were
unambiguously in scope and says so:

```ts
if (evidence.length === 0) {
  for (const record of [...positioning, ...icp].slice(0, 3)) {
    evidence.push({
      memoryRecordId: record.id,
      note: `${record.type}: ${record.key} (attributed by the runner — the model did not name its sources)`,
    });
  }
}
```

The note is deliberately explicit. A reviewer can tell runner-attributed
evidence from model-declared evidence.

---

## How to add a new channel agent

Four steps. The runner, the critic, the evidence rules, the persistence layer
and the review queue require **no changes** — that is the property this design
is claiming, and it was exercised when the content agent was added after the
community agent.

### Step 1 — register the definition

In [`src/lib/agents/registry.ts`](../src/lib/agents/registry.ts):

```ts
{
  id: "linkedin",
  channels: ["linkedin"],
  displayName: "LinkedIn agent",
  description: "Drafts a first-person LinkedIn post from positioning and one messaging pillar.",
  capabilities: ["post_draft"],
  requiredMemory: ["positioning", "messaging_pillar", "voice_rule"],
  estimatedCostUsd: 0.01,
},
```

Registering it alone changes behaviour: `linkedin` stops being a coverage gap on
`/planner` the next time the planner runs, and starts being scheduled.

### Step 2 — write the implementation

Create `src/lib/agents/linkedin.ts`. This is a complete, minimal agent:

```ts
import "server-only";
import { z } from "zod";
import type { ChannelAgent, EvidenceItem } from "./types";

const draftSchema = z.object({
  content: z.string().min(40),
  usedRecordKeys: z.array(z.string()).default([]),
});

export const linkedinAgent: ChannelAgent = {
  id: "linkedin",
  channel: "linkedin",
  requiredMemory: ["positioning", "messaging_pillar", "voice_rule"],

  async run({ memory, tools }) {
    const positioning = memory.byType.positioning ?? [];
    const pillars = memory.byType.messaging_pillar ?? [];
    const voice = (memory.byType.voice_rule ?? []).filter(
      (r) => r.locale === memory.locale,
    );

    if (positioning.length === 0) {
      throw new Error("Cannot draft without positioning in memory. Compile the strategy first.");
    }

    const system = `You draft a single LinkedIn post on behalf of a company.

First person, no hashtags, no engagement bait. Use only claims supported by the
records below — never invent a metric, a customer count, or a benchmark.
Follow the voice rules; they were observed from this company's own writing.
"usedRecordKeys" must list the memory keys you actually leaned on.

Return JSON: {"content","usedRecordKeys"}`;

    const user = `Locale: ${memory.locale}

POSITIONING:
${positioning.map((p) => `- ${p.key}: ${JSON.stringify(p.value)}`).join("\n")}

MESSAGING PILLARS:
${pillars.map((p) => `- ${p.key}: ${JSON.stringify(p.value)}`).join("\n")}

VOICE RULES (${memory.locale}):
${voice.map((p) => `- ${p.key}: ${JSON.stringify(p.value)}`).join("\n") || "(none compiled — write plainly)"}`;

    const draft = await tools.completeJson(
      { task: "draft", system, user, maxTokens: 1200 },
      draftSchema,
    );

    // Resolve claimed keys against records that actually exist.
    const evidence: EvidenceItem[] = [];
    for (const key of draft.usedRecordKeys) {
      const record = memory.all.find((r) => r.key === key);
      if (record) {
        evidence.push({ memoryRecordId: record.id, note: `${record.type}: ${record.key}` });
      }
    }
    if (evidence.length === 0) {
      for (const record of positioning.slice(0, 2)) {
        evidence.push({
          memoryRecordId: record.id,
          note: `${record.type}: ${record.key} (attributed by the runner — the model did not name its sources)`,
        });
      }
    }

    tools.log(`drafted linkedin post, ${evidence.length} evidence item(s)`);

    return {
      artifacts: [{
        kind: "post",
        channel: "linkedin",
        content: draft.content,
        locale: memory.locale,
        evidence,
      }],
    };
  },
};
```

Two details are load-bearing and easy to get wrong:

- **Resolve claimed keys against `memory.all`.** A model will name a key that
  does not exist. Pushing it unchecked would produce evidence linking to
  nothing.
- **Return at least one evidence item**, or the runner throws and the job fails.

### Step 3 — wire it into the runner map

In [`src/lib/agents/runner.ts`](../src/lib/agents/runner.ts):

```ts
const IMPLEMENTATIONS: Record<string, ChannelAgent> = {
  launch_community: launchCommunityAgent,
  content: contentAgent,
  linkedin: linkedinAgent,   // add this
};
```

This map and the registry array are the only two places that change.

### Step 4 — run it

Through the planner, once `linkedin` appears in the compiled channel priorities:

```bash
# /planner → Run planner now → /review → Run queued work
```

Or directly over the API, without waiting for the planner:

```bash
curl -X POST localhost:3000/api/v1/agents \
  -H 'content-type: application/json' \
  -d '{"agentId":"linkedin","channel":"linkedin"}'
```

### What you get without writing it

Because the agent only returns artifacts, everything downstream is inherited:
the critic scores it against the same voice rules, the evidence panel renders
its citations, staleness propagates through them when a cited record is edited,
review records an edit distance under the new agent id, and the metrics chart
picks it up as a new series with its own colour from the validated palette.

### What is not inherited

- **Publishing behaviour.** `publishTargetFor` in
  [`src/lib/publish.ts`](../src/lib/publish.ts) has a `switch` on channel and
  falls through to a generic copy-and-confirm target. A new channel needing
  file export or a specific composer URL must be added there.
- **Channel guidance for the community agent.** `CHANNEL_GUIDANCE` in
  `launch-community.ts` is a separate map keyed by channel slug; a channel added
  to that agent's `channels` array without a guidance entry falls back to the
  `x` guidance.
