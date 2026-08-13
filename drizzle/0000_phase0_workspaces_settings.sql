CREATE TABLE "settings" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"encrypted_model_key" text,
	"model_provider" text DEFAULT 'groq' NOT NULL,
	"search_provider" text DEFAULT 'tavily' NOT NULL,
	"model_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"domain" text NOT NULL,
	"locales" text[] DEFAULT '{"en"}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;