CREATE TYPE "file_ingest_batch_status" AS ENUM('uploading', 'processing', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "file_ingest_file_status" AS ENUM('pending', 'uploaded', 'processing', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "file_ingest_batches" (
	"id" uuid PRIMARY KEY,
	"created_by" uuid NOT NULL,
	"status" "file_ingest_batch_status" NOT NULL,
	"error" text,
	"expires_at" timestamp with time zone NOT NULL,
	"committed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file_ingest_files" (
	"batch_id" uuid,
	"hash" varchar(64),
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"size" bigint NOT NULL,
	"mimetype" text NOT NULL,
	"needs_compile" boolean NOT NULL,
	"status" "file_ingest_file_status" NOT NULL,
	"error" text,
	"uploaded_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "file_ingest_files_pkey" PRIMARY KEY("batch_id","hash"),
	CONSTRAINT "uq_file_ingest_files_batch_position" UNIQUE("batch_id","position"),
	CONSTRAINT "ck_file_ingest_files_position_nonnegative" CHECK ("position" >= 0),
	CONSTRAINT "ck_file_ingest_files_name_nonempty" CHECK (length("name") > 0),
	CONSTRAINT "ck_file_ingest_files_size_nonnegative" CHECK ("size" >= 0),
	CONSTRAINT "ck_file_ingest_files_hash_sha256" CHECK ("hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "source_deletion_outbox" (
	"source_id" uuid PRIMARY KEY,
	"vault_id" uuid NOT NULL,
	"file_path" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "url_ingest_requests" (
	"id" uuid PRIMARY KEY,
	"created_by" uuid NOT NULL,
	"canonical_url" text NOT NULL,
	"origin" text,
	"dispatched_at" timestamp with time zone,
	"dispatched_task_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "source_proposals" DROP CONSTRAINT "source_proposals_document_id_fkey";--> statement-breakpoint
DROP INDEX "ix_replies_running_updated_at";--> statement-breakpoint
DROP INDEX "ix_source_proposals_document_id";--> statement-breakpoint
ALTER TABLE "replies" ADD COLUMN "dispatched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "replies" ADD COLUMN "dispatched_task_id" uuid;--> statement-breakpoint
ALTER TABLE "replies" ADD COLUMN "generation_cursor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "replies" ADD COLUMN "active_generation_step" integer;--> statement-breakpoint
ALTER TABLE "replies" ADD COLUMN "active_generation_kind" text;--> statement-breakpoint
ALTER TABLE "replies" ADD COLUMN "active_generation_key" text;--> statement-breakpoint
ALTER TABLE "source_documents" ADD COLUMN "canonical_url" text;--> statement-breakpoint
ALTER TABLE "source_proposals" ADD COLUMN "source_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "source_proposals" DROP COLUMN "document_id";--> statement-breakpoint
ALTER TABLE "source_proposals" ALTER COLUMN "dest_path" DROP DEFAULT;--> statement-breakpoint
CREATE INDEX "ix_file_ingest_batches_status_expires_at" ON "file_ingest_batches" ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_llm_cost_events_query_correlation" ON "llm_cost_events" ("event_type","correlation_id") WHERE "event_type" = 'query.stream' AND "correlation_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_pipeline_runs_compile_intent_id" ON "pipeline_runs" ("compile_intent_id");--> statement-breakpoint
CREATE INDEX "ix_replies_pending_dispatch" ON "replies" ("created_at") WHERE "status" = 'running' AND "dispatched_at" IS NULL;--> statement-breakpoint
CREATE INDEX "ix_source_deletion_outbox_pending" ON "source_deletion_outbox" ("created_at") WHERE "completed_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_source_documents_vault_canonical_url" ON "source_documents" ("vault_id","canonical_url") WHERE "canonical_url" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_source_proposals_source_id" ON "source_proposals" ("source_id");--> statement-breakpoint
CREATE INDEX "ix_url_ingest_requests_pending" ON "url_ingest_requests" ("created_at") WHERE "dispatched_at" IS NULL;--> statement-breakpoint
ALTER TABLE "file_ingest_batches" ADD CONSTRAINT "file_ingest_batches_id_fkey" FOREIGN KEY ("id") REFERENCES "pipeline_runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "file_ingest_batches" ADD CONSTRAINT "file_ingest_batches_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "file_ingest_files" ADD CONSTRAINT "file_ingest_files_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "file_ingest_batches"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "source_deletion_outbox" ADD CONSTRAINT "source_deletion_outbox_vault_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "url_ingest_requests" ADD CONSTRAINT "url_ingest_requests_id_fkey" FOREIGN KEY ("id") REFERENCES "pipeline_runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "url_ingest_requests" ADD CONSTRAINT "url_ingest_requests_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "replies" ADD CONSTRAINT "replies_active_generation_check" CHECK (("active_generation_step" IS NULL AND "active_generation_kind" IS NULL AND "active_generation_key" IS NULL) OR ("active_generation_step" IS NOT NULL AND "active_generation_kind" IN ('model', 'tool') AND "active_generation_key" IS NOT NULL));