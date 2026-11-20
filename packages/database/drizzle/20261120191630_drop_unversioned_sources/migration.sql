ALTER TABLE "source_incarnations" DROP CONSTRAINT "source_incarnations_cleanup_requires_deletion";--> statement-breakpoint
ALTER TABLE "source_incarnations" DROP COLUMN "unversioned";--> statement-breakpoint
ALTER TABLE "source_incarnations" DROP COLUMN "legacy_completed_at";--> statement-breakpoint
ALTER TABLE "source_incarnations" ADD CONSTRAINT "source_incarnations_cleanup_requires_deletion" CHECK ("deleted_at" IS NOT NULL OR ("attempt_count" = 0 AND "last_attempt_at" IS NULL AND "completed_at" IS NULL));
