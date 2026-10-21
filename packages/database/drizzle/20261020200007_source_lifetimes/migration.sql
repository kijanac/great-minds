LOCK TABLE "pipeline_runs", "file_ingest_batches", "source_proposals", "source_documents", "source_deletion_outbox" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "pipeline_runs" WHERE "status" IN ('pending', 'running'))
    OR EXISTS (SELECT 1 FROM "file_ingest_batches" WHERE "status" IN ('uploading', 'processing'))
    OR EXISTS (SELECT 1 FROM "source_proposals" WHERE "status" = 'PENDING') THEN
    RAISE EXCEPTION 'Source lifetime migration requires drained pipelines and uploads, resolved pending proposals, and quiescent old writers';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "source_deletion_outbox" RENAME TO "source_incarnations";
--> statement-breakpoint
ALTER TABLE "source_incarnations" RENAME CONSTRAINT "source_deletion_outbox_vault_id_fkey" TO "source_incarnations_vault_id_fkey";
--> statement-breakpoint
ALTER TABLE "source_incarnations" DROP CONSTRAINT "source_deletion_outbox_pkey";
--> statement-breakpoint
DROP INDEX "ix_source_deletion_outbox_pending";
--> statement-breakpoint
ALTER TABLE "source_incarnations" RENAME COLUMN "completed_at" TO "legacy_completed_at";
--> statement-breakpoint
ALTER TABLE "source_incarnations" ADD COLUMN "id" uuid DEFAULT gen_random_uuid() NOT NULL;
--> statement-breakpoint
ALTER TABLE "source_incarnations" ADD COLUMN "unversioned" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "source_incarnations" ADD COLUMN "deleted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "source_incarnations" ADD COLUMN "completed_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "source_incarnations" SET "unversioned" = true, "deleted_at" = "created_at";
--> statement-breakpoint
ALTER TABLE "source_incarnations" ADD CONSTRAINT "source_incarnations_pkey" PRIMARY KEY ("id");
--> statement-breakpoint
ALTER TABLE "source_incarnations" ADD CONSTRAINT "source_incarnations_identity" UNIQUE ("id", "source_id", "vault_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "source_incarnations_active_source" ON "source_incarnations" ("source_id") WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "source_incarnations_active_path" ON "source_incarnations" ("vault_id", "file_path") WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "source_incarnations_pending_cleanup" ON "source_incarnations" ("deleted_at") WHERE "deleted_at" IS NOT NULL AND "completed_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "source_incarnations" ADD CONSTRAINT "source_incarnations_cleanup_requires_deletion" CHECK ("deleted_at" IS NOT NULL OR ("attempt_count" = 0 AND "last_attempt_at" IS NULL AND "completed_at" IS NULL AND "legacy_completed_at" IS NULL));
--> statement-breakpoint
INSERT INTO "source_incarnations" ("source_id", "vault_id", "file_path", "unversioned")
SELECT "id", "vault_id", "file_path", true FROM "source_documents";
--> statement-breakpoint
ALTER TABLE "source_documents" ADD COLUMN "incarnation_id" uuid;
--> statement-breakpoint
UPDATE "source_documents" AS documents SET "incarnation_id" = incarnations."id"
FROM "source_incarnations" AS incarnations
WHERE incarnations."source_id" = documents."id"
  AND incarnations."vault_id" = documents."vault_id"
  AND incarnations."deleted_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "source_documents" ALTER COLUMN "incarnation_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "source_documents" ADD CONSTRAINT "source_documents_incarnation_fkey" FOREIGN KEY ("incarnation_id", "id", "vault_id") REFERENCES "source_incarnations" ("id", "source_id", "vault_id");
--> statement-breakpoint
ALTER TABLE "file_ingest_files" ADD COLUMN "source_incarnation_id" uuid;
--> statement-breakpoint
ALTER TABLE "file_ingest_files" ADD CONSTRAINT "file_ingest_files_source_incarnation_id_fkey" FOREIGN KEY ("source_incarnation_id") REFERENCES "source_incarnations" ("id");
--> statement-breakpoint
ALTER TABLE "url_ingest_requests" ADD COLUMN "source_incarnation_id" uuid;
--> statement-breakpoint
ALTER TABLE "url_ingest_requests" ADD CONSTRAINT "url_ingest_requests_source_incarnation_id_fkey" FOREIGN KEY ("source_incarnation_id") REFERENCES "source_incarnations" ("id");
--> statement-breakpoint
ALTER TABLE "source_proposals" ADD COLUMN "source_incarnation_id" uuid;
--> statement-breakpoint
ALTER TABLE "source_proposals" ADD CONSTRAINT "source_proposals_source_incarnation_id_fkey" FOREIGN KEY ("source_incarnation_id") REFERENCES "source_incarnations" ("id");
--> statement-breakpoint
DELETE FROM "topic_membership" AS membership
WHERE NOT EXISTS (SELECT 1 FROM "ideas" WHERE "ideas"."idea_id" = membership."idea_id");
--> statement-breakpoint
ALTER TABLE "topic_membership" ADD CONSTRAINT "topic_membership_idea_id_fkey" FOREIGN KEY ("idea_id") REFERENCES "ideas" ("idea_id") ON DELETE CASCADE;
