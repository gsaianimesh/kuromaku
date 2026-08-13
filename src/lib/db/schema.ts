import {
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Phase 0 schema only. The remaining tables from SPEC section 6 land in Phase 1.
 */

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  domain: text("domain").notNull(),
  locales: text("locales").array().notNull().default(["en"]),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * One row per workspace. `encryptedModelKey` holds an AES-256-GCM envelope
 * (see lib/crypto.ts) — never a plaintext key, and never selected into a log.
 */
export const settings = pgTable("settings", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  encryptedModelKey: text("encrypted_model_key"),
  modelProvider: text("model_provider").notNull().default("groq"),
  searchProvider: text("search_provider").notNull().default("tavily"),
  modelConfig: jsonb("model_config").notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Workspace = typeof workspaces.$inferSelect;
export type Settings = typeof settings.$inferSelect;
