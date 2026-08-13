import { relations, sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/*
 * Full data model from SPEC section 6.
 *
 * `agents` is deliberately absent: the spec calls for the agent registry to be
 * seeded in code, not the database, so it lives in src/lib/agents/registry.ts.
 * Foreign keys reference agents by string id without a constraint.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const sourceKind = pgEnum("source_kind", ["page", "search_result", "human"]);

export const memoryType = pgEnum("memory_type", [
  "product_fact",
  "icp_segment",
  "positioning",
  "messaging_pillar",
  "objection",
  "voice_rule",
  "competitor",
  "channel_priority",
  "roadmap_item",
]);

export const memoryStatus = pgEnum("memory_status", ["active", "superseded"]);

export const memoryOrigin = pgEnum("memory_origin", [
  "compiled",
  "human",
  "observed",
]);

export const jobStatus = pgEnum("job_status", [
  "queued",
  "running",
  "done",
  "failed",
]);

export const artifactStatus = pgEnum("artifact_status", [
  "draft",
  "approved",
  "rejected",
  "published",
  "stale",
]);

export const reviewDecision = pgEnum("review_decision", [
  "approve",
  "edit",
  "reject",
]);

export const observationSource = pgEnum("observation_source", [
  "manual",
  "gsc",
  "import",
]);

export const gapStatus = pgEnum("gap_status", ["open", "acknowledged"]);

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Sources and memory
// ---------------------------------------------------------------------------

export const sources = pgTable(
  "sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    kind: sourceKind("kind").notNull(),
    title: text("title"),
    rawText: text("raw_text"),
    contentHash: text("content_hash").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Dedup key: the same content within a workspace is stored once (SPEC 7.1).
    uniqueIndex("sources_workspace_hash_uq").on(t.workspaceId, t.contentHash),
    index("sources_workspace_idx").on(t.workspaceId),
  ],
);

/**
 * Append only. An edit inserts a new row at version+1 pointing at the old one
 * via supersedesId, and flips the old row to `superseded` (SPEC section 3).
 */
export const memoryRecords = pgTable(
  "memory_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    type: memoryType("type").notNull(),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    locale: text("locale").notNull().default("en"),
    confidence: real("confidence").notNull(),
    status: memoryStatus("status").notNull().default("active"),
    version: integer("version").notNull().default(1),
    supersedesId: uuid("supersedes_id"),
    origin: memoryOrigin("origin").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("memory_workspace_type_idx").on(t.workspaceId, t.type, t.status),
    index("memory_key_idx").on(t.workspaceId, t.key),
  ],
);

/**
 * A memory record with zero rows here is "unsourced" and must render a visible
 * warning (SPEC section 6). Absence of a row is the signal — do not add a
 * nullable placeholder that would hide it.
 */
export const recordSources = pgTable(
  "record_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    recordId: uuid("record_id")
      .notNull()
      .references(() => memoryRecords.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id").references(() => sources.id, {
      onDelete: "set null",
    }),
    url: text("url"),
    snippet: text("snippet"),
  },
  (t) => [index("record_sources_record_idx").on(t.recordId)],
);

/**
 * Which memory records were compiled from which other memory records.
 *
 * The compiler passes earlier records into later stages as prompt context — a
 * positioning statement is derived from product facts and ICP segments. Without
 * recording that, editing a product fact could not invalidate the positioning
 * built on it, and the system's central claim ("editing a record invalidates
 * what came from it") held only for artifacts, one hop away.
 *
 * Edges are written at compile time, when the dependency set is already known,
 * and are walked recursively by editRecord.
 */
export const recordDerivations = pgTable(
  "record_derivations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The record the stage produced. */
    derivedRecordId: uuid("derived_record_id")
      .notNull()
      .references(() => memoryRecords.id, { onDelete: "cascade" }),
    /** A record that was in the prompt when it was produced. */
    sourceRecordId: uuid("source_record_id")
      .notNull()
      .references(() => memoryRecords.id, { onDelete: "cascade" }),
    /** Which compile stage created the edge, for tracing. */
    stage: text("stage").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("record_derivations_edge_uq").on(
      t.derivedRecordId,
      t.sourceRecordId,
    ),
    // The recursive walk traverses source → derived, so that direction is the
    // one that needs an index.
    index("record_derivations_source_idx").on(t.sourceRecordId),
  ],
);

export const researchCache = pgTable(
  "research_cache",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    normalisedQuery: text("normalised_query").notNull(),
    queryHash: text("query_hash").notNull(),
    provider: text("provider").notNull(),
    result: jsonb("result").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Scoped per workspace: the same query for two workspaces is two caches,
    // but never called twice within one (SPEC section 5).
    uniqueIndex("research_cache_hash_uq").on(t.workspaceId, t.queryHash),
  ],
);

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull().default({}),
    idempotencyKey: text("idempotency_key").notNull(),
    status: jobStatus("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    /** Retry backoff, and a hook for scheduled work. Claim ignores future rows. */
    runAfter: timestamp("run_after", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Why the planner scheduled this, in plain language (SPEC section 6). */
    reason: text("reason"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    // Partial on purpose. The queue's job is to prevent *concurrent* duplicate
    // execution (SPEC section 2, defect 6), so only queued and running rows
    // reserve a key. Terminal rows release it, because re-running is a required
    // behaviour: SPEC 7.2 says re-compiling must supersede rather than
    // duplicate, and Phase 2 must be able to re-crawl. A key reserved forever
    // by a `done` row would make both impossible.
    //
    // Not scheduling *redundant* work ("this was already done recently") is a
    // planning decision, and lives in the planner (SPEC 7.4) where it has the
    // history and observations needed to judge it.
    uniqueIndex("jobs_idempotency_key_uq")
      .on(t.idempotencyKey)
      .where(sql`status in ('queued', 'running')`),
    // Supports the claim query's WHERE status/runAfter + ORDER BY createdAt.
    index("jobs_claim_idx").on(t.status, t.runAfter, t.createdAt),
    index("jobs_workspace_idx").on(t.workspaceId, t.createdAt),
  ],
);

/**
 * One row per model call. SPEC section 4: every call is logged and inspectable.
 *
 * `job_id` is nullable and detaches rather than cascading. Deleting a job used
 * to destroy its model-call history along with it — a cleanup during
 * development silently removed 19 of 22 rows, and with them the only record of
 * what those calls cost. An audit trail that disappears when the thing it
 * audits is tidied away is not an audit trail.
 */
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    /** Kept verbatim so a detached run still says what it belonged to. */
    jobType: text("job_type"),
    agentId: text("agent_id").notNull(),
    model: text("model").notNull(),
    prompt: text("prompt"),
    toolCalls: jsonb("tool_calls"),
    rawOutput: text("raw_output"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("agent_runs_job_idx").on(t.jobId)],
);

// ---------------------------------------------------------------------------
// Artifacts, review, performance
// ---------------------------------------------------------------------------

export const artifacts = pgTable(
  "artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    agentId: text("agent_id").notNull(),
    kind: text("kind").notNull(),
    status: artifactStatus("status").notNull().default("draft"),
    /** As generated. Never overwritten, so edit distance stays computable. */
    content: text("content").notNull(),
    /** After human edit. Null until someone edits. */
    contentFinal: text("content_final"),
    /** Critic score and violations (SPEC 7.6). */
    criticScore: real("critic_score"),
    criticNotes: jsonb("critic_notes"),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    locale: text("locale").notNull().default("en"),
    externalUrl: text("external_url"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (t) => [
    index("artifacts_workspace_status_idx").on(t.workspaceId, t.status),
    index("artifacts_agent_idx").on(t.agentId, t.createdAt),
  ],
);

/**
 * Both the evidence panel and the staleness graph (SPEC section 6). Superseding
 * a memory record walks this table to mark derived artifacts stale.
 */
export const artifactEvidence = pgTable(
  "artifact_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    memoryRecordId: uuid("memory_record_id").references(() => memoryRecords.id, {
      onDelete: "set null",
    }),
    sourceUrl: text("source_url"),
    data: jsonb("data"),
    note: text("note"),
  },
  (t) => [
    index("artifact_evidence_artifact_idx").on(t.artifactId),
    index("artifact_evidence_record_idx").on(t.memoryRecordId),
  ],
);

export const reviews = pgTable(
  "reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    decision: reviewDecision("decision").notNull(),
    reason: text("reason"),
    /** Normalised Levenshtein, 0 to 1. Null unless the decision was an edit. */
    editDistance: real("edit_distance"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("reviews_artifact_idx").on(t.artifactId)],
);

/** Recorded, never generated (SPEC section 3). No row means no metric to show. */
export const observations = pgTable(
  "observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    artifactId: uuid("artifact_id").references(() => artifacts.id, {
      onDelete: "cascade",
    }),
    metric: text("metric").notNull(),
    value: numeric("value", { precision: 20, scale: 4 }).notNull(),
    source: observationSource("source").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("observations_workspace_idx").on(t.workspaceId, t.observedAt),
    index("observations_artifact_idx").on(t.artifactId),
  ],
);

/**
 * A prioritised channel with no registered agent. The single most important
 * behavioural difference from Okara (SPEC section 3) — visible, not silent.
 */
export const coverageGaps = pgTable(
  "coverage_gaps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    priorityRank: integer("priority_rank"),
    rationale: text("rationale"),
    status: gapStatus("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("coverage_gaps_workspace_channel_uq").on(t.workspaceId, t.channel),
  ],
);

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const jobsRelations = relations(jobs, ({ many, one }) => ({
  runs: many(agentRuns),
  artifacts: many(artifacts),
  workspace: one(workspaces, {
    fields: [jobs.workspaceId],
    references: [workspaces.id],
  }),
}));

export const agentRunsRelations = relations(agentRuns, ({ one }) => ({
  job: one(jobs, { fields: [agentRuns.jobId], references: [jobs.id] }),
}));

export const artifactsRelations = relations(artifacts, ({ many, one }) => ({
  evidence: many(artifactEvidence),
  reviews: many(reviews),
  observations: many(observations),
  job: one(jobs, { fields: [artifacts.jobId], references: [jobs.id] }),
}));

export const artifactEvidenceRelations = relations(artifactEvidence, ({ one }) => ({
  artifact: one(artifacts, {
    fields: [artifactEvidence.artifactId],
    references: [artifacts.id],
  }),
  memoryRecord: one(memoryRecords, {
    fields: [artifactEvidence.memoryRecordId],
    references: [memoryRecords.id],
  }),
}));

export const memoryRecordsRelations = relations(memoryRecords, ({ many }) => ({
  sources: many(recordSources),
  evidence: many(artifactEvidence),
}));

export const recordSourcesRelations = relations(recordSources, ({ one }) => ({
  record: one(memoryRecords, {
    fields: [recordSources.recordId],
    references: [memoryRecords.id],
  }),
  source: one(sources, {
    fields: [recordSources.sourceId],
    references: [sources.id],
  }),
}));

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type Workspace = typeof workspaces.$inferSelect;
export type Settings = typeof settings.$inferSelect;
export type Source = typeof sources.$inferSelect;
export type MemoryRecord = typeof memoryRecords.$inferSelect;
export type RecordSource = typeof recordSources.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type AgentRun = typeof agentRuns.$inferSelect;
export type Artifact = typeof artifacts.$inferSelect;
export type ArtifactEvidence = typeof artifactEvidence.$inferSelect;
export type Review = typeof reviews.$inferSelect;
export type Observation = typeof observations.$inferSelect;
export type CoverageGap = typeof coverageGaps.$inferSelect;

export type MemoryType = (typeof memoryType.enumValues)[number];
export type JobStatus = (typeof jobStatus.enumValues)[number];
export type ArtifactStatus = (typeof artifactStatus.enumValues)[number];
