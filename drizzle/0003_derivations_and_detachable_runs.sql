CREATE TABLE "record_derivations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"derived_record_id" uuid NOT NULL,
	"source_record_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_job_id_jobs_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_runs" ALTER COLUMN "job_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "job_type" text;--> statement-breakpoint
ALTER TABLE "record_derivations" ADD CONSTRAINT "record_derivations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_derivations" ADD CONSTRAINT "record_derivations_derived_record_id_memory_records_id_fk" FOREIGN KEY ("derived_record_id") REFERENCES "public"."memory_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_derivations" ADD CONSTRAINT "record_derivations_source_record_id_memory_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."memory_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "record_derivations_edge_uq" ON "record_derivations" USING btree ("derived_record_id","source_record_id");--> statement-breakpoint
CREATE INDEX "record_derivations_source_idx" ON "record_derivations" USING btree ("source_record_id");--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;