import "server-only";
import { z } from "zod";
import type { ChannelAgent, DraftedArtifact, EvidenceItem } from "./types";

/**
 * Content agent (SPEC 7.5, second): long-form and comparison pages. Built to
 * prove the ChannelAgent contract generalises — it shares the runner, the
 * evidence rules and the critic with the community agent, and required no
 * change to any of them.
 */

const draftSchema = z.object({
  kind: z.enum(["long_form", "comparison_page"]),
  title: z.string().min(5),
  /** Markdown body. */
  body: z.string().min(200),
  usedRecordKeys: z.array(z.string()).default([]),
  /** Competitor URLs the comparison rests on. */
  usedCompetitorUrls: z.array(z.string()).default([]),
});

export const contentAgent: ChannelAgent = {
  id: "content",
  channel: "content",
  requiredMemory: [
    "positioning",
    "messaging_pillar",
    "objection",
    "competitor",
    "voice_rule",
  ],

  async run({ job, memory, tools }) {
    const payload = job.payload as { kind?: string; topic?: string };
    const positioning = memory.byType.positioning ?? [];
    const pillars = memory.byType.messaging_pillar ?? [];
    const objections = memory.byType.objection ?? [];
    const competitors = memory.byType.competitor ?? [];
    const voice = (memory.byType.voice_rule ?? []).filter(
      (r) => r.locale === memory.locale,
    );

    if (positioning.length === 0) {
      throw new Error(
        "Cannot draft content without positioning in memory. Compile the strategy first.",
      );
    }

    const wantsComparison =
      payload.kind === "comparison_page" ||
      (competitors.length > 0 && payload.kind === undefined);

    if (wantsComparison && competitors.length === 0) {
      throw new Error(
        "A comparison page needs competitor records, and none are in memory. Configure a search provider and re-compile, or request a long-form piece instead.",
      );
    }

    const memoryBlock = [
      `POSITIONING:\n${positioning.map((p) => `- ${p.key}: ${JSON.stringify(p.value)}`).join("\n")}`,
      `MESSAGING PILLARS:\n${pillars.map((p) => `- ${p.key}: ${JSON.stringify(p.value)}`).join("\n")}`,
      `OBJECTIONS:\n${objections.map((p) => `- ${p.key}: ${JSON.stringify(p.value)}`).join("\n")}`,
      competitors.length > 0
        ? `COMPETITORS:\n${competitors.map((p) => `- ${p.key}: ${JSON.stringify(p.value)}`).join("\n")}`
        : "COMPETITORS: (none in memory)",
      `VOICE RULES (${memory.locale}):\n${
        voice.length > 0
          ? voice.map((p) => `- ${p.key}: ${JSON.stringify(p.value)}`).join("\n")
          : "(none compiled for this locale — write plainly)"
      }`,
    ].join("\n\n");

    const system = `You write a ${wantsComparison ? "comparison page" : "long-form article"} from a compiled marketing memory.

Hard rules:
- Every factual claim must trace to a record below. Never invent a metric,
  a benchmark, a price, or a customer count.
- When you describe a competitor, describe only what the competitor record
  says. Do not characterise a product you have no record for.
- Follow the voice rules — they were observed from this company's own writing.
- Address the objections where they naturally arise, rather than in a list.
- Markdown body. Use headings. No call-to-action boilerplate.

Return JSON: {"kind","title","body","usedRecordKeys","usedCompetitorUrls"}`;

    const user = `Locale: ${memory.locale}
${payload.topic ? `Requested topic: ${payload.topic}` : "Topic: choose the one best supported by the memory below."}

=== COMPILED MEMORY ===
${memoryBlock}`;

    const draft = await tools.completeJson(
      { task: "draft", system, user, maxTokens: 3000 },
      draftSchema,
    );

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
    for (const url of draft.usedCompetitorUrls) {
      const competitor = competitors.find(
        (c) => (c.value as { url?: string }).url === url,
      );
      if (competitor) {
        evidence.push({
          memoryRecordId: competitor.id,
          sourceUrl: url,
          note: `Competitor: ${competitor.key}`,
        });
      }
    }

    if (evidence.length === 0) {
      for (const record of [...positioning, ...pillars].slice(0, 3)) {
        evidence.push({
          memoryRecordId: record.id,
          note: `${record.type}: ${record.key} (attributed by the runner — the model did not name its sources)`,
        });
      }
    }

    const artifact: DraftedArtifact = {
      kind: draft.kind,
      channel: "content",
      content: `# ${draft.title}\n\n${draft.body}`,
      locale: memory.locale,
      evidence,
    };

    tools.log(
      `drafted ${draft.kind} "${draft.title}", ${evidence.length} evidence item(s)`,
    );

    return { artifacts: [artifact] };
  },
};
