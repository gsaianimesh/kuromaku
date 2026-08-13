import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { settings, workspaces, type Workspace } from "./db/schema";

/**
 * v1 is single-tenant and unauthenticated (an internal tool). The seed
 * workspace is ShogunAI, per SPEC section 1. Multi-workspace support is a
 * later concern, but every table already carries workspace_id so it is a
 * routing change rather than a schema migration.
 */
export const SEED_WORKSPACE = {
  name: "ShogunAI",
  domain: "shogunaios.com",
  locales: ["en"],
} as const;

/** Idempotent: returns the existing workspace, or creates the seed one. */
export async function getOrCreateDefaultWorkspace(): Promise<Workspace> {
  const db = getDb();

  const existing = await db.select().from(workspaces).limit(1);
  if (existing.length > 0) return existing[0];

  const [created] = await db
    .insert(workspaces)
    .values({
      name: SEED_WORKSPACE.name,
      domain: SEED_WORKSPACE.domain,
      locales: [...SEED_WORKSPACE.locales],
    })
    .returning();

  // Settings row is created alongside so the BYOK screen always has a target.
  await db
    .insert(settings)
    .values({ workspaceId: created.id })
    .onConflictDoNothing();

  return created;
}

export async function getWorkspace(id: string): Promise<Workspace | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, id))
    .limit(1);
  return rows[0] ?? null;
}
