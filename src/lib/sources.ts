import "server-only";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "./db";
import { jobs, sources, type Source } from "./db/schema";

export async function listSources(
  workspaceId: string,
  limit = 200,
): Promise<Source[]> {
  const db = getDb();
  return db
    .select()
    .from(sources)
    .where(eq(sources.workspaceId, workspaceId))
    .orderBy(desc(sources.fetchedAt))
    .limit(limit);
}

export async function getSource(id: string): Promise<Source | null> {
  const db = getDb();
  const [row] = await db.select().from(sources).where(eq(sources.id, id)).limit(1);
  return row ?? null;
}

export async function sourceStats(workspaceId: string): Promise<{
  count: number;
  totalChars: number;
  lastFetchedAt: Date | null;
}> {
  const db = getDb();
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      totalChars: sql<number>`coalesce(sum(length(${sources.rawText})), 0)::int`,
      lastFetchedAt: sql<Date | null>`max(${sources.fetchedAt})`,
    })
    .from(sources)
    .where(eq(sources.workspaceId, workspaceId));
  return row;
}

/** The crawl job currently in flight for this workspace, if any. */
export async function activeCrawl(workspaceId: string) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.workspaceId, workspaceId),
        eq(jobs.type, "crawl_site"),
        inArray(jobs.status, ["queued", "running"]),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Most recent crawl job regardless of status, for the "last run" line. */
export async function lastCrawl(workspaceId: string) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.workspaceId, workspaceId), eq(jobs.type, "crawl_site")))
    .orderBy(desc(jobs.createdAt))
    .limit(1);
  return row ?? null;
}
