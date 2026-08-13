import "server-only";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "./db";
import {
  artifactEvidence,
  artifacts,
  memoryRecords,
  recordSources,
  sources,
  type MemoryRecord,
  type MemoryType,
} from "./db/schema";

export type RecordWithSources = MemoryRecord & {
  sources: Array<{
    id: string;
    url: string | null;
    snippet: string | null;
    sourceTitle: string | null;
  }>;
  /** True when nothing grounds this record — renders a warning (SPEC section 6). */
  unsourced: boolean;
};

export const MEMORY_TYPE_LABELS: Record<MemoryType, string> = {
  product_fact: "Product facts",
  icp_segment: "ICP segments",
  positioning: "Positioning",
  messaging_pillar: "Messaging pillars",
  objection: "Objections",
  voice_rule: "Voice rules",
  competitor: "Competitors",
  channel_priority: "Channel priorities",
  roadmap_item: "Roadmap items",
};

/** Display order matches the compile chain in SPEC 7.2. */
export const MEMORY_TYPE_ORDER: MemoryType[] = [
  "product_fact",
  "icp_segment",
  "positioning",
  "messaging_pillar",
  "objection",
  "competitor",
  "channel_priority",
  "roadmap_item",
  "voice_rule",
];

async function attachSources(rows: MemoryRecord[]): Promise<RecordWithSources[]> {
  if (rows.length === 0) return [];
  const db = getDb();

  const links = await db
    .select({
      recordId: recordSources.recordId,
      id: recordSources.id,
      url: recordSources.url,
      snippet: recordSources.snippet,
      sourceTitle: sources.title,
    })
    .from(recordSources)
    .leftJoin(sources, eq(recordSources.sourceId, sources.id))
    .where(
      inArray(
        recordSources.recordId,
        rows.map((r) => r.id),
      ),
    );

  const byRecord = new Map<string, RecordWithSources["sources"]>();
  for (const l of links) {
    const list = byRecord.get(l.recordId) ?? [];
    list.push({ id: l.id, url: l.url, snippet: l.snippet, sourceTitle: l.sourceTitle });
    byRecord.set(l.recordId, list);
  }

  return rows.map((r) => {
    const s = byRecord.get(r.id) ?? [];
    return { ...r, sources: s, unsourced: s.length === 0 };
  });
}

export async function listActiveMemory(
  workspaceId: string,
): Promise<RecordWithSources[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(memoryRecords)
    .where(
      and(
        eq(memoryRecords.workspaceId, workspaceId),
        eq(memoryRecords.status, "active"),
      ),
    )
    .orderBy(memoryRecords.type, memoryRecords.key);
  return attachSources(rows);
}

export async function getRecord(id: string): Promise<RecordWithSources | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(memoryRecords)
    .where(eq(memoryRecords.id, id))
    .limit(1);
  if (!rows[0]) return null;
  return (await attachSources(rows))[0];
}

/** Full version chain for a key, newest first. */
export async function recordHistory(
  workspaceId: string,
  type: MemoryType,
  key: string,
  locale: string,
): Promise<RecordWithSources[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(memoryRecords)
    .where(
      and(
        eq(memoryRecords.workspaceId, workspaceId),
        eq(memoryRecords.type, type),
        eq(memoryRecords.key, key),
        eq(memoryRecords.locale, locale),
      ),
    )
    .orderBy(desc(memoryRecords.version));
  return attachSources(rows);
}

export async function memoryStats(workspaceId: string): Promise<{
  total: number;
  unsourced: number;
  byType: Record<string, number>;
  locales: string[];
  averageConfidence: number | null;
}> {
  const db = getDb();

  const [totals] = await db
    .select({
      total: sql<number>`count(*)::int`,
      avg: sql<number | null>`avg(${memoryRecords.confidence})`,
    })
    .from(memoryRecords)
    .where(
      and(
        eq(memoryRecords.workspaceId, workspaceId),
        eq(memoryRecords.status, "active"),
      ),
    );

  const byTypeRows = await db
    .select({ type: memoryRecords.type, n: sql<number>`count(*)::int` })
    .from(memoryRecords)
    .where(
      and(
        eq(memoryRecords.workspaceId, workspaceId),
        eq(memoryRecords.status, "active"),
      ),
    )
    .groupBy(memoryRecords.type);

  const localeRows = await db
    .selectDistinct({ locale: memoryRecords.locale })
    .from(memoryRecords)
    .where(
      and(
        eq(memoryRecords.workspaceId, workspaceId),
        eq(memoryRecords.status, "active"),
      ),
    );

  const [unsourcedRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(memoryRecords)
    .where(
      and(
        eq(memoryRecords.workspaceId, workspaceId),
        eq(memoryRecords.status, "active"),
        sql`not exists (select 1 from ${recordSources} rs where rs.record_id = ${memoryRecords.id})`,
      ),
    );

  return {
    total: totals?.total ?? 0,
    unsourced: unsourcedRow?.n ?? 0,
    byType: Object.fromEntries(byTypeRows.map((r) => [r.type, r.n])),
    locales: localeRows.map((r) => r.locale).sort(),
    averageConfidence: totals?.avg ?? null,
  };
}

/**
 * Human edit (SPEC 7.3). Creates a new version, supersedes the old one, and
 * marks every artifact derived from the old record as stale.
 *
 * Returns the ids of artifacts that went stale, so the UI can say exactly what
 * this edit invalidated — the headline demo moment.
 */
export async function editRecord(
  recordId: string,
  newValue: Record<string, unknown>,
  confidence: number,
): Promise<{ newRecordId: string; staleArtifactIds: string[] }> {
  const db = getDb();

  const [prior] = await db
    .select()
    .from(memoryRecords)
    .where(eq(memoryRecords.id, recordId))
    .limit(1);
  if (!prior) throw new Error("Record not found");
  if (prior.status !== "active") {
    throw new Error("Only the active version of a record can be edited");
  }

  const [created] = await db
    .insert(memoryRecords)
    .values({
      workspaceId: prior.workspaceId,
      type: prior.type,
      key: prior.key,
      value: newValue,
      locale: prior.locale,
      confidence,
      status: "active",
      version: prior.version + 1,
      supersedesId: prior.id,
      // A human asserted this, so it is sourced by definition (SPEC section 3).
      origin: "human",
    })
    .returning();

  await db
    .update(memoryRecords)
    .set({ status: "superseded" })
    .where(eq(memoryRecords.id, prior.id));

  await db.insert(recordSources).values({
    recordId: created.id,
    sourceId: null,
    url: null,
    snippet: "Asserted by a human via the memory editor.",
  });

  // Staleness propagation: anything whose evidence cites the superseded record.
  const derived = await db
    .selectDistinct({ artifactId: artifactEvidence.artifactId })
    .from(artifactEvidence)
    .where(eq(artifactEvidence.memoryRecordId, prior.id));

  const staleArtifactIds = derived.map((d) => d.artifactId);

  if (staleArtifactIds.length > 0) {
    await db
      .update(artifacts)
      .set({ status: "stale" })
      .where(
        and(
          inArray(artifacts.id, staleArtifactIds),
          // Published work stays published; marking it stale would misreport
          // what is actually live. It surfaces as stale evidence instead.
          inArray(artifacts.status, ["draft", "approved", "rejected"]),
        ),
      );
  }

  return { newRecordId: created.id, staleArtifactIds };
}
