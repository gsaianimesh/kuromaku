import "server-only";
import { z } from "zod";
import { runModel, runModelJson } from "./model";
import type { RecordWithSources } from "./memory";

/**
 * The critic (SPEC 7.6): a second pass before a human sees anything. Scores a
 * draft against active voice rules and positioning, returns a score and
 * specific violations. Below threshold the draft is revised once automatically,
 * then surfaced with the critic's notes attached.
 */

export const CRITIC_THRESHOLD = 0.7;

export const criticSchema = z.object({
  score: z.union([z.number(), z.string().transform(Number)]).pipe(
    z.number().min(0).max(1),
  ),
  violations: z
    .array(
      z.object({
        rule: z.string(),
        problem: z.string(),
        severity: z.enum(["high", "medium", "low"]).default("medium"),
      }),
    )
    .default([]),
  /** What the critic would keep. Useful context when the draft is revised. */
  strengths: z.array(z.string()).default([]),
});

export type CriticResult = z.infer<typeof criticSchema> & {
  revised: boolean;
};

function rulesBlock(voice: RecordWithSources[], positioning: RecordWithSources[]) {
  return `VOICE RULES:
${
  voice.length > 0
    ? voice.map((r) => `- ${r.key}: ${JSON.stringify(r.value)}`).join("\n")
    : "(none compiled — judge against plain, non-promotional writing)"
}

POSITIONING:
${positioning.map((r) => `- ${r.key}: ${JSON.stringify(r.value)}`).join("\n")}`;
}

export async function critique(input: {
  workspaceId: string;
  jobId: string;
  agentId: string;
  content: string;
  channel: string;
  voice: RecordWithSources[];
  positioning: RecordWithSources[];
  log?: (m: string) => void;
}): Promise<{ result: CriticResult; finalContent: string }> {
  const system = `You review a marketing draft before a human sees it.

Score it 0 to 1 on how well it follows the voice rules and stays consistent
with the positioning. Be specific: every violation must name the rule it
breaks and what in the draft breaks it.

Judge only what is written. Do not reward or penalise length. Flag any claim
that reads as a metric, benchmark, or customer count — those must not appear
unless the positioning or a product fact supports them.

Return JSON: {"score", "violations":[{"rule","problem","severity"}], "strengths":[]}`;

  const user = `Channel: ${input.channel}

${rulesBlock(input.voice, input.positioning)}

=== DRAFT ===
${input.content}`;

  const first = await runModelJson(
    {
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      agentId: `${input.agentId}:critic`,
      task: "critique",
      system,
      messages: [{ role: "user", content: user }],
      maxTokens: 1200,
      onWait: (m) => input.log?.(`  ${m}`),
    },
    criticSchema,
  );

  input.log?.(
    `critic: score ${first.value.score.toFixed(2)}, ${first.value.violations.length} violation(s)`,
  );

  if (first.value.score >= CRITIC_THRESHOLD) {
    return {
      result: { ...first.value, revised: false },
      finalContent: input.content,
    };
  }

  // Below threshold: revise once, automatically (SPEC 7.6).
  input.log?.(
    `critic: below ${CRITIC_THRESHOLD} threshold, revising once`,
  );

  const revisionSystem = `You revise a draft to fix specific, named problems.

Fix only what is listed. Keep everything the reviewer called a strength. Do not
add claims, metrics, or examples that were not already present.

Return only the revised draft text — no preamble, no explanation, no quotes.`;

  const revisionUser = `${rulesBlock(input.voice, input.positioning)}

=== ORIGINAL DRAFT ===
${input.content}

=== PROBLEMS TO FIX ===
${first.value.violations.map((v) => `- [${v.severity}] ${v.rule}: ${v.problem}`).join("\n")}

=== KEEP ===
${first.value.strengths.map((s) => `- ${s}`).join("\n") || "(nothing specified)"}`;

  const revised = await runModel({
    workspaceId: input.workspaceId,
    jobId: input.jobId,
    agentId: `${input.agentId}:critic-revise`,
    task: "draft",
    system: revisionSystem,
    messages: [{ role: "user", content: revisionUser }],
    maxTokens: 1600,
    onWait: (m) => input.log?.(`  ${m}`),
  });

  const finalContent = revised.text.trim() || input.content;

  // Re-score so the artifact carries the score of what is actually shown.
  const second = await runModelJson(
    {
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      agentId: `${input.agentId}:critic-rescore`,
      task: "critique",
      system,
      messages: [
        {
          role: "user",
          content: `Channel: ${input.channel}\n\n${rulesBlock(input.voice, input.positioning)}\n\n=== DRAFT ===\n${finalContent}`,
        },
      ],
      maxTokens: 1200,
      onWait: (m) => input.log?.(`  ${m}`),
    },
    criticSchema,
  );

  input.log?.(
    `critic: rescored ${second.value.score.toFixed(2)} after revision`,
  );

  return {
    result: { ...second.value, revised: true },
    finalContent,
  };
}
