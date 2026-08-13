import "server-only";
import { z } from "zod";
import type { ChannelAgent, DraftedArtifact, EvidenceItem } from "./types";

/**
 * Launch and community agent (SPEC 7.5, built first because engagement data
 * returns within hours, which is the only way the feedback loop is
 * demonstrable inside this timeframe).
 *
 * It searches for real discussions, evaluates fit against the ICP, and drafts
 * a post or comment angle with the thread URL as evidence. When search is
 * unavailable it drafts from memory alone and says so in the evidence — it
 * does not invent thread URLs, because a fabricated link is worse than no link.
 */

const draftSchema = z.object({
  kind: z.enum(["post", "comment_angle"]),
  content: z.string().min(40),
  /** Which memory record keys the draft leans on, for the evidence panel. */
  usedRecordKeys: z.array(z.string()).default([]),
  /** Which of the supplied thread URLs the draft responds to. */
  usedThreadUrls: z.array(z.string()).default([]),
  rationale: z.string().max(400),
});

const CHANNEL_GUIDANCE: Record<string, string> = {
  hacker_news: `Hacker News. No marketing voice at all. Lead with the technical
substance or the concrete problem. Never open with the product name. A comment
angle should add something the thread does not already say.`,
  x: `X. One post, under 280 characters unless it is a thread. Plain claims,
no hashtags, no emoji strings, no engagement bait.`,
  product_hunt: `Product Hunt. A maker comment: what you built, why, and what is
genuinely different. Specific, not superlative.`,
  indie_communities: `Indie founder communities. Peer-to-peer, first person,
concrete about the problem and what you learned. No pitch.`,
};

export const launchCommunityAgent: ChannelAgent = {
  id: "launch_community",
  channel: "x",
  requiredMemory: [
    "icp_segment",
    "positioning",
    "messaging_pillar",
    "voice_rule",
    "product_fact",
  ],

  async run({ job, memory, tools }) {
    const channel = (job.payload as { channel?: string }).channel ?? "x";
    const guidance = CHANNEL_GUIDANCE[channel] ?? CHANNEL_GUIDANCE.x;

    const icp = memory.byType.icp_segment ?? [];
    const positioning = memory.byType.positioning ?? [];
    const pillars = memory.byType.messaging_pillar ?? [];
    const voice = (memory.byType.voice_rule ?? []).filter(
      (r) => r.locale === memory.locale,
    );
    const facts = memory.byType.product_fact ?? [];

    if (icp.length === 0 || positioning.length === 0) {
      throw new Error(
        "Cannot draft without ICP segments and positioning in memory. Compile the strategy first.",
      );
    }

    // Find real discussions. Queries are built from the ICP's own language.
    const queries: string[] = [];
    for (const seg of icp.slice(0, 2)) {
      const v = seg.value as { segment?: string; painPoints?: string[] };
      if (v.painPoints?.length) {
        queries.push(`${v.painPoints[0]} discussion`);
      }
      if (v.segment) queries.push(`${v.segment} ${channel.replace("_", " ")}`);
    }

    const threads: Array<{ url: string; title: string; snippet: string }> = [];
    let searchNote: string | undefined;

    for (const q of queries.slice(0, 3)) {
      const outcome = await tools.search(q);
      if (outcome.unavailable) {
        searchNote = outcome.unavailable;
        tools.log(`search "${q}": ${outcome.unavailable}`);
      } else {
        tools.log(
          `search "${q}": ${outcome.results.length} result(s)${outcome.fromCache ? " (cached)" : ""}`,
        );
        threads.push(...outcome.results.map((r) => ({ url: r.url, title: r.title, snippet: r.snippet })));
      }
    }

    const threadBlock =
      threads.length > 0
        ? threads
            .slice(0, 8)
            .map((t, i) => `[${i}] ${t.title}\n    ${t.url}\n    ${t.snippet.slice(0, 200)}`)
            .join("\n")
        : "(no discussions available — web search is not configured)";

    const memoryBlock = [
      `POSITIONING:\n${positioning.map((p) => `- ${p.key}: ${JSON.stringify(p.value)}`).join("\n")}`,
      `ICP:\n${icp.map((p) => `- ${p.key}: ${JSON.stringify(p.value)}`).join("\n")}`,
      `MESSAGING PILLARS:\n${pillars.map((p) => `- ${p.key}: ${JSON.stringify(p.value)}`).join("\n")}`,
      `PRODUCT FACTS:\n${facts.map((p) => `- ${p.key}: ${JSON.stringify(p.value)}`).join("\n")}`,
      `VOICE RULES (${memory.locale}):\n${
        voice.length > 0
          ? voice.map((p) => `- ${p.key}: ${JSON.stringify(p.value)}`).join("\n")
          : "(none compiled for this locale — write plainly and avoid marketing register)"
      }`,
    ].join("\n\n");

    const system = `You draft for a specific community channel on behalf of a company.

${guidance}

Hard rules:
- Use only claims supported by the PRODUCT FACTS below. Never invent a metric,
  a user count, a benchmark, or a customer quote.
- Follow the voice rules. They were observed from the company's own writing.
- If you respond to a discussion, name it by its URL in "usedThreadUrls".
- "usedRecordKeys" must list the memory keys you actually leaned on.
- Write the post itself in "content" — no preamble, no explanation inside it.

Return JSON: {"kind","content","usedRecordKeys","usedThreadUrls","rationale"}`;

    const user = `Channel: ${channel}
Locale: ${memory.locale}

=== COMPILED MEMORY ===
${memoryBlock}

=== REAL DISCUSSIONS FOUND ===
${threadBlock}

Draft one piece for this channel. If a discussion above is a genuine fit for
this ICP, write a comment angle that responds to it and cite its URL. If none
fit, or none were available, write a standalone post and leave usedThreadUrls
empty.`;

    const draft = await tools.completeJson(
      { task: "draft", system, user, maxTokens: 1600 },
      draftSchema,
    );

    // Build evidence. Every item resolves to something real: a memory record
    // that exists, or a thread URL that was actually returned by search.
    const evidence: EvidenceItem[] = [];

    for (const key of draft.usedRecordKeys) {
      const record = memory.all.find((r) => r.key === key);
      if (record) {
        evidence.push({
          memoryRecordId: record.id,
          note: `${record.type}: ${record.key}`,
        });
      }
    }

    for (const url of draft.usedThreadUrls) {
      const thread = threads.find((t) => t.url === url);
      if (thread) {
        evidence.push({
          sourceUrl: url,
          note: `Responds to: ${thread.title}`,
        });
      }
    }

    // An artifact with no evidence is a bug (SPEC 7.5). Rather than fail the
    // job outright, fall back to the records that were unambiguously in scope —
    // positioning is always used by a draft of this kind — and record why.
    if (evidence.length === 0) {
      for (const record of [...positioning, ...icp].slice(0, 3)) {
        evidence.push({
          memoryRecordId: record.id,
          note: `${record.type}: ${record.key} (attributed by the runner — the model did not name its sources)`,
        });
      }
    }

    if (searchNote) {
      evidence.push({
        note: `No discussion search was possible: ${searchNote} This draft rests on compiled memory alone and cites no thread.`,
      });
    }

    const artifact: DraftedArtifact = {
      kind: draft.kind,
      channel,
      content: draft.content,
      locale: memory.locale,
      evidence,
    };

    tools.log(
      `drafted ${draft.kind} for ${channel}, ${evidence.length} evidence item(s)`,
    );

    return { artifacts: [artifact] };
  },
};
