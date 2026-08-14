/**
 * Golden-set runner (SPEC 7.10).
 *
 *   npm run eval
 *
 * Runs each fixed case against the real model and checks the assertions in
 * eval/golden.ts. Run it after any prompt change — the assertions encode the
 * behaviour the system rests on, so a prompt edit that breaks provenance or
 * lets an invented metric through fails here rather than in production.
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { eq } from "drizzle-orm";
import { GOLDEN_CASES, type GoldenCase } from "../eval/golden";
import { getDb } from "../src/lib/db";
import { jobs } from "../src/lib/db/schema";
import { enqueue } from "../src/lib/jobs/queue";
import { runModel } from "../src/lib/model";
import { getOrCreateDefaultWorkspace } from "../src/lib/workspace";
import { STAGES, systemPromptFor } from "../src/lib/compile/stages";

/** A small, fixed corpus. Nothing here changes between runs. */
const FIXTURE_SOURCES = `--- SOURCE 0 ---
url: https://example.test/
title: Kagi Notes — private notes that stay on your Mac

Kagi Notes is a macOS app that keeps your notes on your own machine. Nothing is
uploaded. Notes are encrypted on disk with a key derived from your login. You
bring your own API key if you want AI features; we never see it. Requires macOS
14 or later. Free while in beta.

--- SOURCE 1 ---
url: https://example.test/about
title: About Kagi Notes

We built this because we kept pasting work context into chat tools and losing it.
It is made for solo developers and small teams who care about where their data
lives. There is no cloud sync and no account.`;

const FIXTURE_MEMORY = `POSITIONING:
- private-local-notes: {"statement":"Notes that never leave your machine","category":"note-taking","againstAlternative":"cloud note apps","differentiator":"local-only storage, BYOK"}

ICP:
- solo-developers: {"segment":"Solo developers","description":"Independent developers who care where their data lives","painPoints":["losing work context in chat tools","data leaving their machine"],"whereTheyGather":["Hacker News"]}

MESSAGING PILLARS:
- your-data-stays-put: {"pillar":"Your data stays put","proofPoints":["no cloud sync","encrypted on disk"],"whyItMatters":"No third party holds your notes"}

PRODUCT FACTS:
- local-only-storage: {"fact":"Notes are stored only on the user's machine","category":"privacy"}
- macos-14-required: {"fact":"Requires macOS 14 or later","category":"platform"}

VOICE RULES (en):
- plain-claims: {"rule":"State what it does without superlatives","doExample":"Notes stay on your Mac","dontExample":"The most secure notes app ever built"}`;

const HYPE_DRAFT = `Introducing the most powerful, revolutionary note-taking
experience ever built. Trusted by 50,000 developers worldwide, Kagi Notes is
10x faster than anything else and delivers a 95% improvement in productivity.
Don't miss out — this changes everything.`;

type CaseInput = { system: string; user: string; task: "compile" | "draft" | "critique" };

function stagePrompt(stageId: string, extra = ""): CaseInput {
  const stage = STAGES.find((s) => s.id === stageId)!;
  return {
    task: "compile",
    system: systemPromptFor(stage),
    user: `Company: Kagi Notes (example.test)
Locales in this workspace: en

=== PREVIOUSLY COMPILED RECORDS ===
${FIXTURE_MEMORY}
${extra}

=== SOURCES ===
${FIXTURE_SOURCES}`,
  };
}

const INPUTS: Record<string, CaseInput> = {
  "compiler-product-facts-shape": stagePrompt("product_facts"),
  "compiler-product-facts-provenance": stagePrompt("product_facts"),
  "compiler-product-facts-no-metrics": stagePrompt("product_facts"),
  "compiler-icp-shape": stagePrompt("icp_segments"),
  "compiler-icp-provenance": stagePrompt("icp_segments"),
  "compiler-positioning-shape": stagePrompt("positioning"),
  "compiler-positioning-no-metrics": stagePrompt("positioning"),
  "compiler-pillars-shape": stagePrompt("messaging_pillars"),
  "compiler-objections-shape": stagePrompt("objections"),
  "compiler-competitors-no-invention": stagePrompt(
    "competitors",
    "\n\n=== SEARCH RESULTS ===\n(no search results available)",
  ),
  "compiler-channels-shape": stagePrompt("channel_priorities"),
  "compiler-roadmap-shape": stagePrompt("roadmap_items"),
  "compiler-voice-shape": stagePrompt("voice_rules"),
  "compiler-voice-absent-locale": {
    task: "compile",
    system: systemPromptFor(STAGES.find((s) => s.id === "voice_rules")!),
    user: `Company: Kagi Notes (example.test)
Locales in this workspace: en, ja

Locale for this stage: "ja". Only source material written in this locale counts as grounding for a voice rule.

=== PREVIOUSLY COMPILED RECORDS ===
${FIXTURE_MEMORY}

=== SOURCES ===
${FIXTURE_SOURCES}`,
  },
  "agent-draft-shape": {
    task: "draft",
    system: `You draft for a specific community channel on behalf of a company.

Hacker News. No marketing voice at all. Lead with the technical substance.

Hard rules:
- Use only claims supported by the PRODUCT FACTS below. Never invent a metric,
  a user count, a benchmark, or a customer quote.
- Follow the voice rules.
- "usedRecordKeys" must list the memory keys you actually leaned on.

Return JSON: {"kind","content","usedRecordKeys","usedThreadUrls","rationale"}`,
    user: `Channel: hacker_news
Locale: en

=== COMPILED MEMORY ===
${FIXTURE_MEMORY}

=== REAL DISCUSSIONS FOUND ===
(no discussions available — web search is not configured)

Draft one piece for this channel. If none fit, or none were available, write a
standalone post and leave usedThreadUrls empty.`,
  },
  "critic-shape": {
    task: "critique",
    system: `You review a marketing draft before a human sees it.

Score it 0 to 1 on how well it follows the voice rules and stays consistent
with the positioning. Flag any claim that reads as a metric, benchmark, or
customer count.

Return JSON: {"score", "violations":[{"rule","problem","severity"}], "strengths":[]}`,
    user: `Channel: hacker_news

${FIXTURE_MEMORY}

=== DRAFT ===
Kagi Notes keeps your notes on your Mac. There is no cloud sync and no account,
and the on-disk store is encrypted. It needs macOS 14 or later.`,
  },
  "critic-catches-hype": {
    task: "critique",
    system: `You review a marketing draft before a human sees it.

Score it 0 to 1 on how well it follows the voice rules and stays consistent
with the positioning. Flag any claim that reads as a metric, benchmark, or
customer count — those must not appear unless a product fact supports them.

Return JSON: {"score", "violations":[{"rule","problem","severity"}], "strengths":[]}`,
    user: `Channel: hacker_news

${FIXTURE_MEMORY}

=== DRAFT ===
${HYPE_DRAFT}`,
  },
};

// Three agent cases share one draft call — the assertions differ, the input does not.
INPUTS["agent-draft-no-metrics"] = INPUTS["agent-draft-shape"];
INPUTS["agent-draft-cites-memory"] = INPUTS["agent-draft-shape"];
INPUTS["agent-no-invented-threads"] = INPUTS["agent-draft-shape"];

function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : raw).trim();
  const start = candidate.search(/[[{]/);
  if (start === -1) return undefined;
  const open = candidate[start];
  const close = open === "{" ? "}" : "]";
  const end = candidate.lastIndexOf(close);
  const slice = end > start ? candidate.slice(start, end + 1) : candidate.slice(start);
  try {
    return JSON.parse(slice);
  } catch {
    return undefined;
  }
}

async function main() {
  const ws = await getOrCreateDefaultWorkspace();
  const db = getDb();

  // Model calls need a job to attach to, so the eval owns one.
  await db.delete(jobs).where(eq(jobs.type, "eval_run"));
  const { job } = await enqueue({
    workspaceId: ws.id,
    type: "eval_run",
    idempotencyKey: `eval:${ws.id}:${Date.now()}`,
    payload: {},
    reason: "Golden-set evaluation run.",
  });

  // Same input runs once; several cases assert over the same output.
  const cache = new Map<string, { text: string; parsed: unknown }>();

  let passed = 0;
  const failures: Array<{ id: string; assertion: string; why: string }> = [];

  for (const gcase of GOLDEN_CASES as GoldenCase[]) {
    const input = INPUTS[gcase.id];
    if (!input) {
      failures.push({
        id: gcase.id,
        assertion: "(setup)",
        why: "no fixed input defined for this case",
      });
      continue;
    }

    const cacheKey = `${input.task}::${input.system}::${input.user}`;
    let out = cache.get(cacheKey);
    if (!out) {
      const response = await runModel({
        workspaceId: ws.id,
        jobId: job.id,
        agentId: `eval:${gcase.area}`,
        task: input.task,
        system: input.system,
        messages: [{ role: "user", content: input.user }],
        maxTokens: 2000,
        jsonMode: true,
        // A script has no queue to requeue into, so it can afford to wait out
        // a burst limit rather than abandon the run.
        maxWaitMs: 600_000,
        onWait: (m) => process.stdout.write(`\r  ${m}${" ".repeat(20)}`),
      });
      out = { text: response.text, parsed: extractJson(response.text) };
      cache.set(cacheKey, out);
    }

    const violations = gcase.assertions
      .map((a) => ({ name: a.name, why: a.check(out!.text, out!.parsed) }))
      .filter((v) => v.why !== null);

    if (violations.length === 0) {
      passed++;
      console.log(`\rPASS  ${gcase.id}${" ".repeat(30)}`);
    } else {
      for (const v of violations) {
        failures.push({ id: gcase.id, assertion: v.name, why: v.why! });
      }
      console.log(`\rFAIL  ${gcase.id}${" ".repeat(30)}`);
      for (const v of violations) console.log(`        ${v.name}: ${v.why}`);
    }
  }

  console.log(
    `\n${passed}/${GOLDEN_CASES.length} cases passed (${cache.size} distinct model calls).`,
  );
  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  ${f.id} — ${f.assertion}: ${f.why}`);
  }
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
