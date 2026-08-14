import "server-only";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "./db";
import {
  artifactEvidence,
  artifacts,
  memoryRecords,
  recordDerivations,
  recordSources,
  sources,
  type MemoryRecord,
  type MemoryType,
} from "./db/schema";

/**
 * How a record is grounded.
 *
 * `sourced`     at least one record_sources row: a crawled page, a search
 *               result, or a human assertion.
 * `derived`     no source of its own, but compiled from records that have one.
 *               This is the shared strategy layer working as designed, and it
 *               is shown as a provenance trail rather than a warning.
 * `ungrounded`  neither. Nothing in the system can say where this came from,
 *               so it is capped below 0.5 and flagged.
 */
export type Grounding = "sourced" | "derived" | "ungrounded";

export type DerivationParent = {
  id: string;
  type: MemoryType;
  key: string;
  status: string;
  stage: string;
};

export type RecordWithSources = MemoryRecord & {
  sources: Array<{
    id: string;
    url: string | null;
    snippet: string | null;
    sourceTitle: string | null;
  }>;
  /** The records this one was compiled from, for a `derived` record's trail. */
  derivedFrom: DerivationParent[];
  grounding: Grounding;
  /**
   * True only for `ungrounded`. Kept under this name because it is the field
   * the API, the MCP manifest and the golden set all assert on, and it still
   * means what it always meant: nothing in the system grounds this record.
   */
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

  /*
   * One hop up only. A record's own provenance line names what it was compiled
   * from; those parents carry their own lines, so the reader walks the chain by
   * clicking rather than reading a transitive closure that would run to dozens
   * of entries on a late-stage record.
   */
  const parents = await db
    .select({
      derivedRecordId: recordDerivations.derivedRecordId,
      stage: recordDerivations.stage,
      id: memoryRecords.id,
      type: memoryRecords.type,
      key: memoryRecords.key,
      status: memoryRecords.status,
    })
    .from(recordDerivations)
    .innerJoin(memoryRecords, eq(recordDerivations.sourceRecordId, memoryRecords.id))
    .where(
      inArray(
        recordDerivations.derivedRecordId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(memoryRecords.type, memoryRecords.key);

  const parentsByRecord = new Map<string, DerivationParent[]>();
  for (const p of parents) {
    const list = parentsByRecord.get(p.derivedRecordId) ?? [];
    list.push({ id: p.id, type: p.type, key: p.key, status: p.status, stage: p.stage });
    parentsByRecord.set(p.derivedRecordId, list);
  }

  return rows.map((r) => {
    const s = byRecord.get(r.id) ?? [];
    const derivedFrom = parentsByRecord.get(r.id) ?? [];
    const grounding: Grounding =
      s.length > 0 ? "sourced" : derivedFrom.length > 0 ? "derived" : "ungrounded";
    return { ...r, sources: s, derivedFrom, grounding, unsourced: grounding === "ungrounded" };
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
  /** Records with a source of their own. */
  sourced: number;
  /** Records with no source but with a derivation parent. */
  derived: number;
  /** Records with neither. This is the number that should worry a reader. */
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

  /*
   * One pass, three buckets: has a source, has only a parent, has neither.
   *
   * Written as one raw statement with its own alias. Expressed through the
   * query builder, the correlated `exists` subqueries silently failed to bind
   * the outer row and every bucket came back zero — a memory with 29 sourced
   * records reported none, and the page said so in the header.
   */
  const groundingRows = await db.execute<{
    sourced: number;
    derived: number;
    ungrounded: number;
  }>(sql`
    select
      count(*) filter (
        where exists (select 1 from record_sources rs where rs.record_id = m.id)
      )::int as sourced,
      count(*) filter (
        where not exists (select 1 from record_sources rs where rs.record_id = m.id)
          and exists (select 1 from record_derivations rd where rd.derived_record_id = m.id)
      )::int as derived,
      count(*) filter (
        where not exists (select 1 from record_sources rs where rs.record_id = m.id)
          and not exists (select 1 from record_derivations rd where rd.derived_record_id = m.id)
      )::int as ungrounded
    from memory_records m
    where m.workspace_id = ${workspaceId}::uuid and m.status = 'active'
  `);
  const grounding = groundingRows.rows[0];

  return {
    total: totals?.total ?? 0,
    sourced: grounding?.sourced ?? 0,
    derived: grounding?.derived ?? 0,
    unsourced: grounding?.ungrounded ?? 0,
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
export type EditResult = {
  newRecordId: string;
  staleArtifactIds: string[];
  /** Records downstream of the edit, including the edited one. */
  affectedRecordIds: string[];
};

export async function editRecord(
  recordId: string,
  newValue: Record<string, unknown>,
  confidence: number,
): Promise<EditResult> {
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

  /*
   * Staleness propagation, transitively.
   *
   * The edited record is the root. Everything compiled from it, and everything
   * compiled from those, is downstream — a product fact feeds positioning,
   * positioning feeds messaging pillars, and a draft citing any of them rests
   * on the fact that just changed. A one-hop rule would mark only the drafts
   * citing the root and leave the rest looking current.
   *
   * The path array is what makes this terminate. `UNION` alone dedups on the
   * whole row, so a node reachable at several depths yields one row per depth
   * and diamond-shaped paths multiply combinatorially — which hung a real run
   * on a 199-edge graph. Carrying the path and excluding nodes already on it
   * prevents both cycles and revisits; the depth cap is belt and braces.
   */
  const affected = await db.execute<{ id: string }>(sql`
    with recursive downstream(id, depth, path) as (
      select ${prior.id}::uuid, 0, array[${prior.id}::uuid]
      union all
      select rd.derived_record_id, d.depth + 1, d.path || rd.derived_record_id
      from ${recordDerivations} rd
      join downstream d on rd.source_record_id = d.id
      where d.depth < 16
        and not rd.derived_record_id = any(d.path)
    )
    select distinct id from downstream
  `);

  const affectedRecordIds = affected.rows.map((r) => r.id);

  // Any artifact whose evidence cites the root or anything downstream of it.
  const derived = await db
    .selectDistinct({ artifactId: artifactEvidence.artifactId })
    .from(artifactEvidence)
    .where(inArray(artifactEvidence.memoryRecordId, affectedRecordIds));

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

  return { newRecordId: created.id, staleArtifactIds, affectedRecordIds };
}

/**
 * Records compiled from this one, transitively. Used by the memory viewer to
 * show what an edit would invalidate before the edit is made.
 */
export async function downstreamOf(recordId: string): Promise<
  Array<{ id: string; type: string; key: string; depth: number }>
> {
  const db = getDb();
  const rows = await db.execute<{
    id: string;
    type: string;
    key: string;
    depth: number;
  }>(sql`
    with recursive downstream(id, depth, path) as (
      select ${recordId}::uuid, 0, array[${recordId}::uuid]
      union all
      select rd.derived_record_id, d.depth + 1, d.path || rd.derived_record_id
      from ${recordDerivations} rd
      join downstream d on rd.source_record_id = d.id
      where d.depth < 16
        and not rd.derived_record_id = any(d.path)
    ),
    shallowest as (
      select distinct on (id) id, depth from downstream order by id, depth
    )
    select m.id, m.type::text as type, m.key, d.depth
    from shallowest d
    join ${memoryRecords} m on m.id = d.id
    where d.depth > 0 and m.status = 'active'
    order by d.depth, m.type, m.key
  `);
  return rows.rows;
}
