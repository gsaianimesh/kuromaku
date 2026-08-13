import "server-only";
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb } from "./db";
import {
  artifactEvidence,
  artifacts,
  memoryRecords,
  observations,
  reviews,
  type Artifact,
  type ArtifactStatus,
} from "./db/schema";
import { normalisedEditDistance } from "./text";

export type EvidenceView = {
  id: string;
  note: string | null;
  sourceUrl: string | null;
  data: unknown;
  memoryRecordId: string | null;
  /** Null when the cited record no longer exists. */
  recordKey: string | null;
  recordType: string | null;
  recordStatus: string | null;
};

export type ArtifactView = Artifact & {
  evidence: EvidenceView[];
  /** Evidence citing a superseded record — why the artifact went stale. */
  staleEvidence: EvidenceView[];
  observationCount: number;
};

async function hydrate(rows: Artifact[]): Promise<ArtifactView[]> {
  if (rows.length === 0) return [];
  const db = getDb();
  const ids = rows.map((r) => r.id);

  const ev = await db
    .select({
      id: artifactEvidence.id,
      artifactId: artifactEvidence.artifactId,
      note: artifactEvidence.note,
      sourceUrl: artifactEvidence.sourceUrl,
      data: artifactEvidence.data,
      memoryRecordId: artifactEvidence.memoryRecordId,
      recordKey: memoryRecords.key,
      recordType: memoryRecords.type,
      recordStatus: memoryRecords.status,
    })
    .from(artifactEvidence)
    .leftJoin(memoryRecords, eq(artifactEvidence.memoryRecordId, memoryRecords.id))
    .where(inArray(artifactEvidence.artifactId, ids));

  const obs = await db
    .select({ artifactId: observations.artifactId, n: sql<number>`count(*)::int` })
    .from(observations)
    .where(inArray(observations.artifactId, ids))
    .groupBy(observations.artifactId);

  const obsByArtifact = new Map(obs.map((o) => [o.artifactId, o.n]));

  return rows.map((r) => {
    const mine = ev.filter((e) => e.artifactId === r.id);
    return {
      ...r,
      evidence: mine,
      staleEvidence: mine.filter((e) => e.recordStatus === "superseded"),
      observationCount: obsByArtifact.get(r.id) ?? 0,
    };
  });
}

export async function listArtifacts(
  workspaceId: string,
  status?: ArtifactStatus[],
): Promise<ArtifactView[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(artifacts)
    .where(
      status && status.length > 0
        ? and(eq(artifacts.workspaceId, workspaceId), inArray(artifacts.status, status))
        : eq(artifacts.workspaceId, workspaceId),
    )
    .orderBy(desc(artifacts.createdAt))
    .limit(100);
  return hydrate(rows);
}

export async function getArtifact(id: string): Promise<ArtifactView | null> {
  const db = getDb();
  const rows = await db.select().from(artifacts).where(eq(artifacts.id, id)).limit(1);
  if (!rows[0]) return null;
  return (await hydrate(rows))[0];
}

/**
 * Approve, edit-and-approve, or reject (SPEC 7.7).
 *
 * On an edit the normalised Levenshtein distance between `content` and
 * `content_final` is computed and stored on the review. `content` is never
 * overwritten, so the distance stays recomputable.
 */
export async function reviewArtifact(input: {
  artifactId: string;
  decision: "approve" | "edit" | "reject";
  editedContent?: string;
  reason?: string;
}): Promise<{ editDistance: number | null }> {
  const db = getDb();
  const [artifact] = await db
    .select()
    .from(artifacts)
    .where(eq(artifacts.id, input.artifactId))
    .limit(1);
  if (!artifact) throw new Error("Artifact not found");

  let editDistance: number | null = null;
  let nextStatus: ArtifactStatus;
  let contentFinal = artifact.contentFinal;

  if (input.decision === "edit") {
    if (!input.editedContent || input.editedContent.trim().length === 0) {
      throw new Error("An edit needs the edited text");
    }
    contentFinal = input.editedContent;
    editDistance = normalisedEditDistance(artifact.content, input.editedContent);
    nextStatus = "approved";
  } else if (input.decision === "approve") {
    nextStatus = "approved";
  } else {
    if (!input.reason || input.reason.trim().length === 0) {
      throw new Error("A rejection needs a reason — it is the signal the system learns from");
    }
    nextStatus = "rejected";
  }

  await db
    .update(artifacts)
    .set({ status: nextStatus, contentFinal })
    .where(eq(artifacts.id, input.artifactId));

  await db.insert(reviews).values({
    artifactId: input.artifactId,
    decision: input.decision,
    reason: input.reason ?? null,
    editDistance,
  });

  return { editDistance };
}

/**
 * Average edit distance per agent over time (SPEC 7.7). Buckets by day so the
 * dashboard can draw a real line rather than a single number.
 *
 * Returns only days that actually have reviews. There is no interpolation and
 * no zero-filling: a day with no review is absent, not a data point at zero.
 */
export async function editDistanceSeries(workspaceId: string): Promise<
  Array<{ day: string; agentId: string; avgDistance: number; reviews: number }>
> {
  const db = getDb();
  const rows = await db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${reviews.createdAt}), 'YYYY-MM-DD')`,
      agentId: artifacts.agentId,
      avgDistance: sql<number>`avg(${reviews.editDistance})`,
      reviews: sql<number>`count(*)::int`,
    })
    .from(reviews)
    .innerJoin(artifacts, eq(reviews.artifactId, artifacts.id))
    .where(
      and(eq(artifacts.workspaceId, workspaceId), isNotNull(reviews.editDistance)),
    )
    .groupBy(sql`date_trunc('day', ${reviews.createdAt})`, artifacts.agentId)
    .orderBy(asc(sql`date_trunc('day', ${reviews.createdAt})`));

  return rows.map((r) => ({
    day: r.day,
    agentId: r.agentId,
    avgDistance: Number(r.avgDistance),
    reviews: r.reviews,
  }));
}

export async function reviewStats(workspaceId: string): Promise<{
  byStatus: Record<string, number>;
  totalReviews: number;
  editsWithDistance: number;
  averageEditDistance: number | null;
  averageCriticScore: number | null;
  perAgent: Array<{ agentId: string; avgDistance: number | null; reviews: number }>;
}> {
  const db = getDb();

  const statusRows = await db
    .select({ status: artifacts.status, n: sql<number>`count(*)::int` })
    .from(artifacts)
    .where(eq(artifacts.workspaceId, workspaceId))
    .groupBy(artifacts.status);

  const [agg] = await db
    .select({
      totalReviews: sql<number>`count(*)::int`,
      withDistance: sql<number>`count(${reviews.editDistance})::int`,
      avgDistance: sql<number | null>`avg(${reviews.editDistance})`,
    })
    .from(reviews)
    .innerJoin(artifacts, eq(reviews.artifactId, artifacts.id))
    .where(eq(artifacts.workspaceId, workspaceId));

  const [critic] = await db
    .select({ avg: sql<number | null>`avg(${artifacts.criticScore})` })
    .from(artifacts)
    .where(eq(artifacts.workspaceId, workspaceId));

  const perAgentRows = await db
    .select({
      agentId: artifacts.agentId,
      avgDistance: sql<number | null>`avg(${reviews.editDistance})`,
      reviews: sql<number>`count(*)::int`,
    })
    .from(reviews)
    .innerJoin(artifacts, eq(reviews.artifactId, artifacts.id))
    .where(eq(artifacts.workspaceId, workspaceId))
    .groupBy(artifacts.agentId);

  return {
    byStatus: Object.fromEntries(statusRows.map((r) => [r.status, r.n])),
    totalReviews: agg?.totalReviews ?? 0,
    editsWithDistance: agg?.withDistance ?? 0,
    averageEditDistance: agg?.avgDistance === null ? null : Number(agg?.avgDistance),
    averageCriticScore: critic?.avg === null ? null : Number(critic?.avg),
    perAgent: perAgentRows.map((r) => ({
      agentId: r.agentId,
      avgDistance: r.avgDistance === null ? null : Number(r.avgDistance),
      reviews: r.reviews,
    })),
  };
}

/** Regenerates a stale artifact by re-running the agent that made it. */
export async function staleArtifacts(workspaceId: string): Promise<ArtifactView[]> {
  return listArtifacts(workspaceId, ["stale"]);
}
