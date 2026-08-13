import "server-only";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import { getDb } from "../db";
import { artifactEvidence, artifacts, type Job, type MemoryType } from "../db/schema";
import { critique } from "../critic";
import { listActiveMemory } from "../memory";
import { runModel, runModelJson } from "../model";
import { searchCached } from "../search";
import { agentById } from "./registry";
import { launchCommunityAgent } from "./launch-community";
import { contentAgent } from "./content";
import type { AgentTools, ChannelAgent, MemorySlice } from "./types";

/**
 * The agent runner. Adding an agent means adding it to this map and the
 * registry — the runner itself does not change, which is what SPEC section 9
 * Phase 8 checks.
 */
const IMPLEMENTATIONS: Record<string, ChannelAgent> = {
  launch_community: launchCommunityAgent,
  content: contentAgent,
};

export function agentImplementation(id: string): ChannelAgent | undefined {
  return IMPLEMENTATIONS[id];
}

async function buildMemorySlice(
  workspaceId: string,
  required: MemoryType[],
  locale: string,
): Promise<MemorySlice> {
  const all = await listActiveMemory(workspaceId);
  const byType: MemorySlice["byType"] = {};
  for (const type of required) {
    byType[type] = all.filter(
      (r) => r.type === type && (type !== "voice_rule" || r.locale === locale),
    );
  }
  return { byType, all, locale };
}

export type RunAgentResult = {
  artifactIds: string[];
  criticScores: number[];
};

export async function runAgentJob(
  job: Job,
  log: (m: string) => void,
): Promise<RunAgentResult> {
  const payload = job.payload as {
    agentId?: string;
    channel?: string;
    locale?: string;
  };
  const agentId = payload.agentId;
  if (!agentId) throw new Error("Job payload is missing agentId");

  const definition = agentById(agentId);
  const implementation = agentImplementation(agentId);
  if (!definition || !implementation) {
    throw new Error(
      `No agent registered with id "${agentId}". Registered: ${Object.keys(IMPLEMENTATIONS).join(", ")}`,
    );
  }

  const locale = payload.locale ?? "en";
  const memory = await buildMemorySlice(job.workspaceId, definition.requiredMemory, locale);

  const missing = definition.requiredMemory.filter(
    (t) => (memory.byType[t] ?? []).length === 0,
  );
  if (missing.length > 0) {
    log(`memory gaps for ${agentId}: ${missing.join(", ")}`);
  }

  const tools: AgentTools = {
    search: (query) => searchCached(job.workspaceId, query),
    complete: async ({ task, system, user, maxTokens }) => {
      const r = await runModel({
        workspaceId: job.workspaceId,
        jobId: job.id,
        agentId,
        task,
        system,
        messages: [{ role: "user", content: user }],
        maxTokens,
        onWait: (m) => log(`  ${m}`),
      });
      return r.text;
    },
    completeJson: async <T>(
      { task, system, user, maxTokens }: {
        task: "draft" | "classify" | "critique";
        system: string;
        user: string;
        maxTokens?: number;
      },
      schema: z.ZodType<T>,
    ) => {
      const r = await runModelJson(
        {
          workspaceId: job.workspaceId,
          jobId: job.id,
          agentId,
          task,
          system,
          messages: [{ role: "user", content: user }],
          maxTokens,
          onWait: (m) => log(`  ${m}`),
        },
        schema,
      );
      return r.value;
    },
    log,
  };

  const { artifacts: drafted } = await implementation.run({ job, memory, tools });

  if (drafted.length === 0) {
    throw new Error(`Agent "${agentId}" produced no artifacts.`);
  }

  const db = getDb();
  const voice = (memory.byType.voice_rule ?? []).filter((r) => r.locale === locale);
  const positioning = memory.byType.positioning ?? [];

  const artifactIds: string[] = [];
  const criticScores: number[] = [];

  for (const draft of drafted) {
    // SPEC 7.5: an artifact with no evidence is a bug and fails validation.
    if (draft.evidence.length === 0) {
      throw new Error(
        `Agent "${agentId}" returned an artifact with no evidence. Every draft must carry the memory records and links it rests on.`,
      );
    }

    const { result, finalContent } = await critique({
      workspaceId: job.workspaceId,
      jobId: job.id,
      agentId,
      content: draft.content,
      channel: draft.channel,
      voice,
      positioning,
      log,
    });

    const [row] = await db
      .insert(artifacts)
      .values({
        workspaceId: job.workspaceId,
        channel: draft.channel,
        agentId,
        kind: draft.kind,
        status: "draft",
        // `content` is what the agent produced, after the critic's automatic
        // revision. Human edits go to contentFinal so edit distance measures
        // the human's change, not the critic's.
        content: finalContent,
        criticScore: result.score,
        criticNotes: {
          violations: result.violations,
          strengths: result.strengths,
          revisedAutomatically: result.revised,
          threshold: 0.7,
        },
        jobId: job.id,
        locale: draft.locale,
      })
      .returning();

    await db.insert(artifactEvidence).values(
      draft.evidence.map((e) => ({
        artifactId: row.id,
        memoryRecordId: e.memoryRecordId ?? null,
        sourceUrl: e.sourceUrl ?? null,
        data: e.data ?? null,
        note: e.note,
      })),
    );

    artifactIds.push(row.id);
    criticScores.push(result.score);
    log(
      `artifact ${row.id.slice(0, 8)}: ${draft.kind} for ${draft.channel}, critic ${result.score.toFixed(2)}${result.revised ? " (revised)" : ""}`,
    );
  }

  return { artifactIds, criticScores };
}

/** Marks an artifact's evidence as resolved for the review queue. */
export async function artifactEvidenceFor(artifactId: string) {
  const db = getDb();
  return db
    .select()
    .from(artifactEvidence)
    .where(eq(artifactEvidence.artifactId, artifactId));
}
