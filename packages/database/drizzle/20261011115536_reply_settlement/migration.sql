ALTER TABLE "replies" ADD COLUMN "settlement" jsonb;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "history_seq" bigint;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "history_sha256" varchar(64);--> statement-breakpoint
CREATE INDEX "ix_replies_pending_settlement" ON "replies" ("created_at") WHERE "status" = 'settling';--> statement-breakpoint
ALTER TABLE "replies" ADD CONSTRAINT "replies_settlement_check" CHECK (("status" = 'settling') = ("settlement" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_history_receipt_check" CHECK (("history_seq" IS NULL AND "history_sha256" IS NULL) OR ("history_seq" IS NOT NULL AND "history_sha256" IS NOT NULL AND "history_seq" BETWEEN 1 AND 9007199254740991 AND "history_sha256" ~ '^[0-9a-f]{64}$'));--> statement-breakpoint
ALTER TABLE "replies" DROP CONSTRAINT "replies_status_check", ADD CONSTRAINT "replies_status_check" CHECK ("status" IN ('running', 'settling', 'completed', 'failed', 'stopped'));