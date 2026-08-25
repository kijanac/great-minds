ALTER TABLE "source_proposals" DROP CONSTRAINT "source_proposals_document_id_fkey";--> statement-breakpoint
DROP INDEX "ix_source_proposals_document_id";--> statement-breakpoint
ALTER TABLE "source_documents" ADD COLUMN "canonical_url" text;--> statement-breakpoint
ALTER TABLE "source_proposals" ADD COLUMN "source_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "source_proposals" DROP COLUMN "document_id";--> statement-breakpoint
ALTER TABLE "source_proposals" ALTER COLUMN "dest_path" DROP DEFAULT;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_source_documents_vault_canonical_url" ON "source_documents" ("vault_id","canonical_url") WHERE "canonical_url" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_source_proposals_source_id" ON "source_proposals" ("source_id");