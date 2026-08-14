import "server-only";
import { and, eq, ilike, or } from "drizzle-orm";
import { getDb } from "./db";
import { memoryRecords, type MemoryType } from "./db/schema";
import { listActiveMemory, type RecordWithSources } from "./memory";
import { listArtifacts } from "./review";
import { recordObservation } from "./publish";
import { AGENTS, agentById } from "./agents/registry";
import { enqueue } from "./jobs/queue";
import { listCoverageGaps } from "./planner";

/**
 * Shared read/write surface for the REST API and the MCP server (SPEC 7.11).
 * Both expose the same functions so they cannot drift.
 *
 * Every memory record returned carries its sources, because a fact without its
 * provenance is exactly what this system exists to avoid — that holds whether a
 * human or another agent is reading it.
 */

export type ApiMemoryRecord = {
  id: string;
  type: string;
  key: string;
  value: unknown;
  locale: string;
  confidence: number;
  version: number;
  origin: string;
  /** "sourced" | "derived" | "ungrounded". See lib/memory.ts. */
  grounding: string;
  /** True only for "ungrounded": nothing in the system grounds this record. */
  unsourced: boolean;
  sources: Array<{ url: string | null; snippet: string | null }>;
  /** Records this one was compiled from. Populated when grounding is "derived". */
  derivedFrom: Array<{ id: string; type: string; key: string }>;
};

function toApi(r: RecordWithSources): ApiMemoryRecord {
  return {
    id: r.id,
    type: r.type,
    key: r.key,
    value: r.value,
    locale: r.locale,
    confidence: r.confidence,
    version: r.version,
    origin: r.origin,
    grounding: r.grounding,
    unsourced: r.unsourced,
    sources: r.sources.map((s) => ({ url: s.url, snippet: s.snippet })),
    derivedFrom: r.derivedFrom.map((p) => ({ id: p.id, type: p.type, key: p.key })),
  };
}

export async function apiGetMemory(
  workspaceId: string,
  opts: { type?: string; locale?: string } = {},
): Promise<ApiMemoryRecord[]> {
  const all = await listActiveMemory(workspaceId);
  return all
    .filter((r) => (opts.type ? r.type === opts.type : true))
    .filter((r) => (opts.locale ? r.locale === opts.locale : true))
    .map(toApi);
}

export async function apiSearchMemory(
  workspaceId: string,
  query: string,
  limit = 20,
): Promise<ApiMemoryRecord[]> {
  const db = getDb();
  const pattern = `%${query.trim()}%`;

  const rows = await db
    .select()
    .from(memoryRecords)
    .where(
      and(
        eq(memoryRecords.workspaceId, workspaceId),
        eq(memoryRecords.status, "active"),
        or(
          ilike(memoryRecords.key, pattern),
          // Cast to text so the search covers every field of the payload.
          ilike(memoryRecords.value as never, pattern),
        ),
      ),
    )
    .limit(limit);

  const ids = new Set(rows.map((r) => r.id));
  const hydrated = await listActiveMemory(workspaceId);
  return hydrated.filter((r) => ids.has(r.id)).map(toApi);
}

export async function apiListArtifacts(
  workspaceId: string,
  status?: string,
) {
  const rows = await listArtifacts(
    workspaceId,
    status ? [status as never] : undefined,
  );
  return rows.map((a) => ({
    id: a.id,
    channel: a.channel,
    agentId: a.agentId,
    kind: a.kind,
    status: a.status,
    locale: a.locale,
    criticScore: a.criticScore,
    content: a.contentFinal ?? a.content,
    externalUrl: a.externalUrl,
    createdAt: a.createdAt.toISOString(),
    publishedAt: a.publishedAt?.toISOString() ?? null,
    evidence: a.evidence.map((e) => ({
      memoryRecordId: e.memoryRecordId,
      recordKey: e.recordKey,
      sourceUrl: e.sourceUrl,
      note: e.note,
      superseded: e.recordStatus === "superseded",
    })),
    observationCount: a.observationCount,
  }));
}

/**
 * Queues an agent run. It never posts anywhere and never runs synchronously —
 * a caller gets a job id and the work happens on the queue like all other work.
 */
export async function apiRunAgent(
  workspaceId: string,
  input: { agentId: string; channel?: string; locale?: string },
): Promise<{ jobId: string; created: boolean; reason: string }> {
  const definition = agentById(input.agentId);
  if (!definition) {
    throw new Error(
      `Unknown agent "${input.agentId}". Registered: ${AGENTS.map((a) => a.id).join(", ")}`,
    );
  }
  const channel = input.channel ?? definition.channels[0];
  if (!definition.channels.includes(channel)) {
    throw new Error(
      `Agent "${input.agentId}" does not serve channel "${channel}". It serves: ${definition.channels.join(", ")}`,
    );
  }

  const reason = `Requested over the API.`;
  const stamp = new Date().toISOString().slice(0, 16);
  const { job, created } = await enqueue({
    workspaceId,
    type: "run_agent",
    idempotencyKey: `api:${workspaceId}:${input.agentId}:${channel}:${stamp}`,
    payload: { agentId: input.agentId, channel, locale: input.locale ?? "en" },
    reason,
  });

  return { jobId: job.id, created, reason };
}

export async function apiRecordObservation(
  workspaceId: string,
  input: { artifactId: string; metric: string; value: number },
): Promise<{ ok: true }> {
  await recordObservation({
    workspaceId,
    artifactId: input.artifactId,
    metric: input.metric,
    value: input.value,
    source: "import",
  });
  return { ok: true };
}

export async function apiCoverageGaps(workspaceId: string) {
  const gaps = await listCoverageGaps(workspaceId);
  return gaps.map((g) => ({
    channel: g.channel,
    priorityRank: g.priorityRank,
    rationale: g.rationale,
    status: g.status,
  }));
}

export function apiListAgents() {
  return AGENTS.map((a) => ({
    id: a.id,
    displayName: a.displayName,
    channels: a.channels,
    description: a.description,
    capabilities: a.capabilities,
    requiredMemory: a.requiredMemory as MemoryType[],
    estimatedCostUsd: a.estimatedCostUsd,
  }));
}
