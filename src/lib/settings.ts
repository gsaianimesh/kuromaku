import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { settings, type Settings } from "./db/schema";
import { decryptSecret, encryptSecret, maskSecret } from "./crypto";
import { getEnv } from "./env";

export type ModelProviderId = "groq" | "anthropic";

export const MODEL_PROVIDERS: ReadonlyArray<{
  id: ModelProviderId;
  label: string;
  keyPrefix: string;
  envFallback: "GROQ_API_KEY" | "ANTHROPIC_API_KEY";
}> = [
  { id: "groq", label: "Groq", keyPrefix: "gsk_", envFallback: "GROQ_API_KEY" },
  {
    id: "anthropic",
    label: "Anthropic",
    keyPrefix: "sk-ant-",
    envFallback: "ANTHROPIC_API_KEY",
  },
];

export const SEARCH_PROVIDERS = ["tavily", "brave", "exa"] as const;

export async function getSettings(workspaceId: string): Promise<Settings> {
  const db = getDb();
  const rows = await db
    .select()
    .from(settings)
    .where(eq(settings.workspaceId, workspaceId))
    .limit(1);
  if (rows[0]) return rows[0];

  const [created] = await db
    .insert(settings)
    .values({ workspaceId })
    .onConflictDoNothing()
    .returning();
  if (created) return created;

  const again = await db
    .select()
    .from(settings)
    .where(eq(settings.workspaceId, workspaceId))
    .limit(1);
  return again[0];
}

/**
 * What the settings screen is allowed to know about a stored key: whether one
 * exists, and its last 4 characters. Never the key itself.
 */
export type KeyStatus =
  | { state: "none" }
  | { state: "stored"; masked: string; updatedAt: Date }
  | { state: "undecryptable"; updatedAt: Date };

export async function getKeyStatus(workspaceId: string): Promise<KeyStatus> {
  const row = await getSettings(workspaceId);
  if (!row?.encryptedModelKey) return { state: "none" };
  try {
    const plain = decryptSecret(row.encryptedModelKey);
    return {
      state: "stored",
      masked: maskSecret(plain),
      updatedAt: row.updatedAt,
    };
  } catch {
    // Almost always means APP_ENCRYPTION_KEY was rotated or differs per env.
    return { state: "undecryptable", updatedAt: row.updatedAt };
  }
}

export async function saveModelKey(
  workspaceId: string,
  plaintext: string,
  provider: ModelProviderId,
): Promise<void> {
  const db = getDb();
  await getSettings(workspaceId);
  await db
    .update(settings)
    .set({
      encryptedModelKey: encryptSecret(plaintext),
      modelProvider: provider,
      updatedAt: new Date(),
    })
    .where(eq(settings.workspaceId, workspaceId));
}

export async function clearModelKey(workspaceId: string): Promise<void> {
  const db = getDb();
  await db
    .update(settings)
    .set({ encryptedModelKey: null, updatedAt: new Date() })
    .where(eq(settings.workspaceId, workspaceId));
}

export async function setSearchProvider(
  workspaceId: string,
  provider: string,
): Promise<void> {
  const db = getDb();
  await getSettings(workspaceId);
  await db
    .update(settings)
    .set({ searchProvider: provider, updatedAt: new Date() })
    .where(eq(settings.workspaceId, workspaceId));
}

/**
 * Resolution order for actual model calls (SPEC section 4): the workspace's
 * BYOK key first, environment variable only as a local-development fallback.
 * Returns the plaintext key — callers must never log or echo it.
 */
export async function resolveModelKey(
  workspaceId: string,
): Promise<{ key: string; source: "byok" | "env"; provider: ModelProviderId } | null> {
  const row = await getSettings(workspaceId);
  const provider = (row?.modelProvider ?? "groq") as ModelProviderId;

  if (row?.encryptedModelKey) {
    try {
      return { key: decryptSecret(row.encryptedModelKey), source: "byok", provider };
    } catch {
      // Fall through to env rather than hard-failing.
    }
  }

  const fallbackVar =
    MODEL_PROVIDERS.find((p) => p.id === provider)?.envFallback ?? "GROQ_API_KEY";
  const env = getEnv();
  const fromEnv = env[fallbackVar];
  if (fromEnv && fromEnv.length > 0) {
    return { key: fromEnv, source: "env", provider };
  }
  return null;
}
