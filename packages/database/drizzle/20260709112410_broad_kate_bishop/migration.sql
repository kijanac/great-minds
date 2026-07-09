CREATE TABLE "pipeline_runs" (
	"id" uuid PRIMARY KEY,
	"vault_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"current_phase" text NOT NULL,
	"phase_status" text NOT NULL,
	"progress_steps" jsonb DEFAULT '[]' NOT NULL,
	"error" text,
	"ingest_task_id" uuid,
	"compile_intent_id" uuid,
	"compile_task_id" uuid,
	"active_task_id" uuid,
	"active_task_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "search_index" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"vault_id" uuid NOT NULL,
	"path" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"heading" text NOT NULL,
	"body" text NOT NULL,
	"content_hash" text NOT NULL,
	"tsv" tsvector NOT NULL,
	"embedding" vector(1024),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_index_vault_id_path_chunk_index_key" UNIQUE("vault_id","path","chunk_index")
);
--> statement-breakpoint
CREATE TABLE "topics" (
	"topic_id" uuid PRIMARY KEY,
	"vault_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"article_status" text DEFAULT 'no_article' NOT NULL,
	"compiled_from_hash" text,
	"rendered_from_hash" text,
	"supersedes" uuid,
	"superseded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topics_vault_id_slug_key" UNIQUE("vault_id","slug")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY,
	"email" varchar(320) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"r2_bucket_name" text
);
--> statement-breakpoint
CREATE TABLE "vaults" (
	"id" uuid PRIMARY KEY,
	"name" varchar(255) NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"r2_bucket_name" text
);
--> statement-breakpoint
CREATE TABLE "wiki_articles" (
	"id" uuid PRIMARY KEY,
	"vault_id" uuid NOT NULL,
	"topic_id" uuid NOT NULL CONSTRAINT "wiki_articles_topic_id_key" UNIQUE,
	"file_path" text NOT NULL,
	"file_hash" text NOT NULL,
	"body_hash" text NOT NULL,
	"title" text NOT NULL,
	"precis" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"render_run_id" uuid,
	"archived" boolean DEFAULT false NOT NULL,
	"tags" text[] DEFAULT ARRAY[]::text[] NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ix_pipeline_runs_vault_id" ON "pipeline_runs" ("vault_id");--> statement-breakpoint
CREATE INDEX "ix_search_index_vault_id" ON "search_index" ("vault_id");--> statement-breakpoint
CREATE INDEX "ix_search_index_tsv" ON "search_index" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "ix_search_index_embedding" ON "search_index" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "ix_topics_vault_id" ON "topics" ("vault_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ix_users_email" ON "users" ("email");--> statement-breakpoint
CREATE INDEX "ix_wiki_articles_vault_id" ON "wiki_articles" ("vault_id");--> statement-breakpoint
CREATE INDEX "ix_wiki_articles_render_run_id" ON "wiki_articles" ("render_run_id") WHERE "render_run_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_vault_id_vaults_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "search_index" ADD CONSTRAINT "search_index_vault_id_vaults_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_vault_id_vaults_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vaults" ADD CONSTRAINT "vaults_owner_id_users_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "wiki_articles" ADD CONSTRAINT "wiki_articles_vault_id_vaults_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "wiki_articles" ADD CONSTRAINT "wiki_articles_topic_id_topics_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "topics"("topic_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "wiki_articles" ADD CONSTRAINT "wiki_articles_render_run_id_pipeline_runs_id_fkey" FOREIGN KEY ("render_run_id") REFERENCES "pipeline_runs"("id") ON DELETE SET NULL;