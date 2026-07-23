CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pgcrypto;--> statement-breakpoint
CREATE TYPE "member_role" AS ENUM('OWNER', 'EDITOR', 'VIEWER');--> statement-breakpoint
CREATE TYPE "proposal_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TABLE "anchors" (
	"idea_id" uuid,
	"position" integer,
	"claim" text NOT NULL,
	"quote" text NOT NULL,
	"chunk_index" integer,
	CONSTRAINT "anchors_pkey" PRIMARY KEY("idea_id","position")
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY,
	"user_id" uuid NOT NULL,
	"key_hash" varchar(64) NOT NULL,
	"label" text NOT NULL,
	"revoked" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_codes" (
	"id" uuid PRIMARY KEY,
	"email" varchar(320) NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backlinks" (
	"source_article_id" uuid,
	"target_article_id" uuid,
	CONSTRAINT "backlinks_pkey" PRIMARY KEY("source_article_id","target_article_id")
);
--> statement-breakpoint
CREATE TABLE "compile_cache_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"vault_id" uuid NOT NULL,
	"phase" text NOT NULL,
	"cache_key" text NOT NULL,
	"value" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compile_cache_entries_vault_id_phase_cache_key_key" UNIQUE("vault_id","phase","cache_key")
);
--> statement-breakpoint
CREATE TABLE "compile_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"vault_id" uuid NOT NULL,
	"pipeline_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone,
	"dispatched_task_id" uuid,
	"satisfied_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ideas" (
	"idea_id" uuid PRIMARY KEY,
	"vault_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"description" text NOT NULL,
	"embedding" vector(1024),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_cost_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid,
	"vault_id" uuid,
	"event_type" text NOT NULL,
	"cost_usd" numeric(12,6) NOT NULL,
	"correlation_id" text
);
--> statement-breakpoint
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
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
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
CREATE TABLE "sessions" (
	"id" text,
	"vault_id" uuid,
	"user_id" uuid NOT NULL,
	"query" text NOT NULL,
	"origin" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"idempotency_key" text,
	CONSTRAINT "sessions_pkey" PRIMARY KEY("id","vault_id"),
	CONSTRAINT "uq_sessions_vault_idempotency" UNIQUE("vault_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "source_documents" (
	"id" uuid PRIMARY KEY,
	"vault_id" uuid NOT NULL,
	"file_path" text NOT NULL,
	"file_hash" text NOT NULL,
	"body_hash" text NOT NULL,
	"client_hash" text,
	"etag" text,
	"source_type" text NOT NULL,
	"url" text,
	"origin" text,
	"provenance_session_id" uuid,
	"provenance_exchange_id" text,
	"provenance_session_query" text,
	"provenance_source_doc_path" text,
	"provenance_source_anchor" text,
	"provenance_source_paragraph_index" integer,
	"provenance_anchored_to" text,
	"provenance_anchored_section" text,
	"provenance_intent" text,
	"title" text,
	"precis" text,
	"author" text,
	"published_date" text,
	"genre" text,
	"tags" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"derived_extras" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_documents_vault_id_file_path_key" UNIQUE("vault_id","file_path")
);
--> statement-breakpoint
CREATE TABLE "source_proposals" (
	"id" uuid PRIMARY KEY,
	"vault_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "proposal_status" NOT NULL,
	"content_type" varchar(50) NOT NULL,
	"title" text,
	"author" text,
	"dest_path" text DEFAULT '' NOT NULL,
	"document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY,
	"vault_id" uuid NOT NULL,
	"type" text NOT NULL,
	"params" jsonb NOT NULL,
	"pipeline_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "topic_links" (
	"source_topic_id" uuid,
	"target_topic_id" uuid,
	CONSTRAINT "topic_links_pkey" PRIMARY KEY("source_topic_id","target_topic_id")
);
--> statement-breakpoint
CREATE TABLE "topic_membership" (
	"topic_id" uuid,
	"idea_id" uuid,
	CONSTRAINT "topic_membership_pkey" PRIMARY KEY("topic_id","idea_id")
);
--> statement-breakpoint
CREATE TABLE "topic_related" (
	"topic_id" uuid,
	"related_topic_id" uuid,
	"shared_ideas" integer NOT NULL,
	"jaccard" double precision NOT NULL,
	CONSTRAINT "topic_related_pkey" PRIMARY KEY("topic_id","related_topic_id")
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
	CONSTRAINT "topics_vault_id_slug_key" UNIQUE("vault_id","slug"),
	CONSTRAINT "ck_topics_article_status" CHECK ("article_status" in ('no_article', 'rendered', 'needs_revision', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY,
	"email" varchar(320) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"r2_bucket_name" text
);
--> statement-breakpoint
CREATE TABLE "vault_memberships" (
	"id" uuid PRIMARY KEY,
	"vault_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "member_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vault_memberships_vault_id_user_id_key" UNIQUE("vault_id","user_id")
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
CREATE TABLE "webauthn_challenges" (
	"challenge" text PRIMARY KEY,
	"kind" text NOT NULL,
	"user_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_webauthn_challenges_kind" CHECK ("kind" in ('registration', 'authentication'))
);
--> statement-breakpoint
CREATE TABLE "webauthn_credentials" (
	"id" uuid PRIMARY KEY,
	"user_id" uuid NOT NULL,
	"credential_id" text NOT NULL CONSTRAINT "uq_webauthn_credentials_credential_id" UNIQUE,
	"public_key" text NOT NULL,
	"sign_count" bigint DEFAULT 0 NOT NULL,
	"transports" text[] DEFAULT '{}'::text[] NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
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
CREATE UNIQUE INDEX "ix_api_keys_key_hash" ON "api_keys" ("key_hash");--> statement-breakpoint
CREATE INDEX "ix_auth_codes_email" ON "auth_codes" ("email");--> statement-breakpoint
CREATE INDEX "ix_compile_cache_entries_vault_id" ON "compile_cache_entries" ("vault_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ix_compile_intents_one_pending" ON "compile_intents" ("vault_id") WHERE "dispatched_at" IS NULL;--> statement-breakpoint
CREATE INDEX "ix_compile_intents_pending" ON "compile_intents" ("created_at") WHERE "dispatched_at" IS NULL;--> statement-breakpoint
CREATE INDEX "ix_compile_intents_pipeline_run_id" ON "compile_intents" ("pipeline_run_id");--> statement-breakpoint
CREATE INDEX "ix_ideas_vault_id" ON "ideas" ("vault_id");--> statement-breakpoint
CREATE INDEX "ix_ideas_document_id" ON "ideas" ("document_id");--> statement-breakpoint
CREATE INDEX "ix_pipeline_runs_vault_id" ON "pipeline_runs" ("vault_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ix_refresh_tokens_token_hash" ON "refresh_tokens" ("token_hash");--> statement-breakpoint
CREATE INDEX "ix_search_index_vault_id" ON "search_index" ("vault_id");--> statement-breakpoint
CREATE INDEX "ix_search_index_tsv" ON "search_index" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "ix_search_index_embedding" ON "search_index" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "ix_sessions_updated_at" ON "sessions" ("updated_at");--> statement-breakpoint
CREATE INDEX "ix_sessions_user_id" ON "sessions" ("user_id");--> statement-breakpoint
CREATE INDEX "ix_sessions_vault_id" ON "sessions" ("vault_id");--> statement-breakpoint
CREATE INDEX "ix_source_documents_vault_client_hash" ON "source_documents" ("vault_id","client_hash") WHERE "client_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_source_documents_vault_id" ON "source_documents" ("vault_id");--> statement-breakpoint
CREATE INDEX "ix_source_proposals_document_id" ON "source_proposals" ("document_id");--> statement-breakpoint
CREATE INDEX "ix_source_proposals_vault_id" ON "source_proposals" ("vault_id");--> statement-breakpoint
CREATE INDEX "ix_tasks_vault_id" ON "tasks" ("vault_id");--> statement-breakpoint
CREATE INDEX "ix_tasks_pipeline_run_id" ON "tasks" ("pipeline_run_id");--> statement-breakpoint
CREATE INDEX "ix_topics_vault_id" ON "topics" ("vault_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ix_users_email" ON "users" ("email");--> statement-breakpoint
CREATE INDEX "ix_wiki_articles_vault_id" ON "wiki_articles" ("vault_id");--> statement-breakpoint
CREATE INDEX "ix_wiki_articles_render_run_id" ON "wiki_articles" ("render_run_id") WHERE "render_run_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "anchors" ADD CONSTRAINT "anchors_idea_id_fkey" FOREIGN KEY ("idea_id") REFERENCES "ideas"("idea_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "backlinks" ADD CONSTRAINT "backlinks_source_article_id_fkey" FOREIGN KEY ("source_article_id") REFERENCES "wiki_articles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "backlinks" ADD CONSTRAINT "backlinks_target_article_id_fkey" FOREIGN KEY ("target_article_id") REFERENCES "wiki_articles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "compile_cache_entries" ADD CONSTRAINT "compile_cache_entries_vault_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "compile_intents" ADD CONSTRAINT "compile_intents_vault_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "compile_intents" ADD CONSTRAINT "compile_intents_pipeline_run_id_fkey" FOREIGN KEY ("pipeline_run_id") REFERENCES "pipeline_runs"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_vault_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "source_documents"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "llm_cost_events" ADD CONSTRAINT "llm_cost_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "llm_cost_events" ADD CONSTRAINT "llm_cost_events_vault_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_vault_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "search_index" ADD CONSTRAINT "search_index_vault_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_vault_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "source_documents" ADD CONSTRAINT "source_documents_vault_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "source_proposals" ADD CONSTRAINT "source_proposals_vault_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "source_proposals" ADD CONSTRAINT "source_proposals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "source_proposals" ADD CONSTRAINT "source_proposals_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "source_documents"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_vault_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_pipeline_run_id_fkey" FOREIGN KEY ("pipeline_run_id") REFERENCES "pipeline_runs"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "topic_links" ADD CONSTRAINT "topic_links_source_topic_id_fkey" FOREIGN KEY ("source_topic_id") REFERENCES "topics"("topic_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "topic_links" ADD CONSTRAINT "topic_links_target_topic_id_fkey" FOREIGN KEY ("target_topic_id") REFERENCES "topics"("topic_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "topic_membership" ADD CONSTRAINT "topic_membership_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "topics"("topic_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "topic_related" ADD CONSTRAINT "topic_related_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "topics"("topic_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "topic_related" ADD CONSTRAINT "topic_related_related_topic_id_fkey" FOREIGN KEY ("related_topic_id") REFERENCES "topics"("topic_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_vault_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vault_memberships" ADD CONSTRAINT "vault_memberships_vault_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vault_memberships" ADD CONSTRAINT "vault_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vaults" ADD CONSTRAINT "vaults_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "wiki_articles" ADD CONSTRAINT "wiki_articles_vault_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "wiki_articles" ADD CONSTRAINT "wiki_articles_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "topics"("topic_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "wiki_articles" ADD CONSTRAINT "fk_wiki_articles_render_run_id_pipeline_runs" FOREIGN KEY ("render_run_id") REFERENCES "pipeline_runs"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE OR REPLACE FUNCTION notify_pipeline_run_changed()
RETURNS trigger AS $$
        BEGIN
            PERFORM pg_notify(
                'pipeline_progress',
                json_build_object(
                    'pipeline_run_id', NEW.id,
                    'vault_id', NEW.vault_id
                )::text
            );
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER pipeline_runs_notify_insert
AFTER INSERT ON pipeline_runs
FOR EACH ROW
EXECUTE FUNCTION notify_pipeline_run_changed();--> statement-breakpoint
CREATE TRIGGER pipeline_runs_notify_update
AFTER UPDATE ON pipeline_runs
FOR EACH ROW
WHEN (
	OLD.status IS DISTINCT FROM NEW.status
	OR OLD.current_phase IS DISTINCT FROM NEW.current_phase
	OR OLD.phase_status IS DISTINCT FROM NEW.phase_status
	OR OLD.progress_steps IS DISTINCT FROM NEW.progress_steps
	OR OLD.error IS DISTINCT FROM NEW.error
	OR OLD.completed_at IS DISTINCT FROM NEW.completed_at
)
EXECUTE FUNCTION notify_pipeline_run_changed();
