CREATE TYPE "public"."artifact_status" AS ENUM('draft', 'approved', 'rejected', 'published', 'stale');--> statement-breakpoint
CREATE TYPE "public"."gap_status" AS ENUM('open', 'acknowledged');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."memory_origin" AS ENUM('compiled', 'human', 'observed');--> statement-breakpoint
CREATE TYPE "public"."memory_status" AS ENUM('active', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."memory_type" AS ENUM('product_fact', 'icp_segment', 'positioning', 'messaging_pillar', 'objection', 'voice_rule', 'competitor', 'channel_priority', 'roadmap_item');--> statement-breakpoint
CREATE TYPE "public"."observation_source" AS ENUM('manual', 'gsc', 'import');--> statement-breakpoint
CREATE TYPE "public"."review_decision" AS ENUM('approve', 'edit', 'reject');--> statement-breakpoint
CREATE TYPE "public"."source_kind" AS ENUM('page', 'search_result', 'human');--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"agent_id" text NOT NULL,
	"model" text NOT NULL,
	"prompt" text,
	"tool_calls" jsonb,
	"raw_output" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" numeric(12, 6),
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifact_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifact_id" uuid NOT NULL,
	"memory_record_id" uuid,
	"source_url" text,
	"data" jsonb,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"agent_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" "artifact_status" DEFAULT 'draft' NOT NULL,
	"content" text NOT NULL,
	"content_final" text,
	"critic_score" real,
	"critic_notes" jsonb,
	"job_id" uuid,
	"locale" text DEFAULT 'en' NOT NULL,
	"external_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "coverage_gaps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"priority_rank" integer,
	"rationale" text,
	"status" "gap_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"locked_at" timestamp with time zone,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "memory_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" "memory_type" NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"confidence" real NOT NULL,
	"status" "memory_status" DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"supersedes_id" uuid,
	"origin" "memory_origin" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"artifact_id" uuid,
	"metric" text NOT NULL,
	"value" numeric(20, 4) NOT NULL,
	"source" "observation_source" NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "record_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"record_id" uuid NOT NULL,
	"source_id" uuid,
	"url" text,
	"snippet" text
);
--> statement-breakpoint
CREATE TABLE "research_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"normalised_query" text NOT NULL,
	"query_hash" text NOT NULL,
	"provider" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifact_id" uuid NOT NULL,
	"decision" "review_decision" NOT NULL,
	"reason" text,
	"edit_distance" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"url" text NOT NULL,
	"kind" "source_kind" NOT NULL,
	"title" text,
	"raw_text" text,
	"content_hash" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_evidence" ADD CONSTRAINT "artifact_evidence_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_evidence" ADD CONSTRAINT "artifact_evidence_memory_record_id_memory_records_id_fk" FOREIGN KEY ("memory_record_id") REFERENCES "public"."memory_records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coverage_gaps" ADD CONSTRAINT "coverage_gaps_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_records" ADD CONSTRAINT "memory_records_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_sources" ADD CONSTRAINT "record_sources_record_id_memory_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."memory_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_sources" ADD CONSTRAINT "record_sources_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_cache" ADD CONSTRAINT "research_cache_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_job_idx" ON "agent_runs" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "artifact_evidence_artifact_idx" ON "artifact_evidence" USING btree ("artifact_id");--> statement-breakpoint
CREATE INDEX "artifact_evidence_record_idx" ON "artifact_evidence" USING btree ("memory_record_id");--> statement-breakpoint
CREATE INDEX "artifacts_workspace_status_idx" ON "artifacts" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "artifacts_agent_idx" ON "artifacts" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "coverage_gaps_workspace_channel_uq" ON "coverage_gaps" USING btree ("workspace_id","channel");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_idempotency_key_uq" ON "jobs" USING btree ("idempotency_key") WHERE status <> 'failed';--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("status","run_after","created_at");--> statement-breakpoint
CREATE INDEX "jobs_workspace_idx" ON "jobs" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "memory_workspace_type_idx" ON "memory_records" USING btree ("workspace_id","type","status");--> statement-breakpoint
CREATE INDEX "memory_key_idx" ON "memory_records" USING btree ("workspace_id","key");--> statement-breakpoint
CREATE INDEX "observations_workspace_idx" ON "observations" USING btree ("workspace_id","observed_at");--> statement-breakpoint
CREATE INDEX "observations_artifact_idx" ON "observations" USING btree ("artifact_id");--> statement-breakpoint
CREATE INDEX "record_sources_record_idx" ON "record_sources" USING btree ("record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "research_cache_hash_uq" ON "research_cache" USING btree ("workspace_id","query_hash");--> statement-breakpoint
CREATE INDEX "reviews_artifact_idx" ON "reviews" USING btree ("artifact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_workspace_hash_uq" ON "sources" USING btree ("workspace_id","content_hash");--> statement-breakpoint
CREATE INDEX "sources_workspace_idx" ON "sources" USING btree ("workspace_id");