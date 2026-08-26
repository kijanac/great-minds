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
CREATE INDEX "ix_file_ingest_batches_status_expires_at" ON "file_ingest_batches" ("status","expires_at");--> statement-breakpoint
ALTER TABLE "file_ingest_batches" ADD CONSTRAINT "file_ingest_batches_id_fkey" FOREIGN KEY ("id") REFERENCES "pipeline_runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "file_ingest_batches" ADD CONSTRAINT "file_ingest_batches_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "file_ingest_files" ADD CONSTRAINT "file_ingest_files_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "file_ingest_batches"("id") ON DELETE CASCADE;