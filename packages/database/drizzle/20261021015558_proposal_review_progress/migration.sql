ALTER TABLE "source_proposals" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "source_proposals" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "source_proposals_unfinished_review" ON "source_proposals" ("reviewed_at") WHERE "reviewed_at" IS NOT NULL AND "completed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "source_proposals" ADD CONSTRAINT "source_proposals_review_progress" CHECK (("status" <> 'PENDING' OR "reviewed_at" IS NULL) AND ("reviewed_at" IS NOT NULL OR "completed_at" IS NULL));