ALTER TABLE "replies" DROP CONSTRAINT "replies_kind_check";--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_kind_check";--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_btw_origin_check";--> statement-breakpoint
ALTER TABLE "replies" ADD COLUMN "settlement" jsonb;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "placement" text DEFAULT 'standalone' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "reply_mode" text DEFAULT 'query' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "history_seq" bigint;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "history_sha256" varchar(64);--> statement-breakpoint
ALTER TABLE "replies" DROP COLUMN "kind";--> statement-breakpoint
UPDATE "sessions" SET "placement" = CASE WHEN "kind" = 'btw' THEN 'inline' ELSE 'standalone' END, "reply_mode" = CASE WHEN "kind" = 'btw' THEN 'btw' ELSE 'query' END;--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "kind";--> statement-breakpoint
CREATE INDEX "ix_replies_pending_settlement" ON "replies" ("created_at") WHERE "status" = 'settling';--> statement-breakpoint
CREATE INDEX "ix_replies_pending_admission" ON "replies" ("created_at") WHERE "status" = 'admitting';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_replies_live_session" ON "replies" ("vault_id","session_id") WHERE "status" IN ('admitting', 'running', 'settling');--> statement-breakpoint
ALTER TABLE "replies" ADD CONSTRAINT "replies_settlement_check" CHECK (("status" = 'settling') = ("settlement" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_history_receipt_check" CHECK (("history_seq" IS NULL AND "history_sha256" IS NULL) OR ("history_seq" IS NOT NULL AND "history_sha256" IS NOT NULL AND "history_seq" BETWEEN 1 AND 9007199254740991 AND "history_sha256" ~ '^[0-9a-f]{64}$'));--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_placement_check" CHECK ("placement" IN ('inline', 'standalone'));--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_reply_mode_check" CHECK ("reply_mode" IN ('btw', 'query'));--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_revision_check" CHECK ("revision" >= 0);--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_inline_origin_check" CHECK ("placement" != 'inline' OR "origin"->>'anchor' IS NOT NULL);--> statement-breakpoint
ALTER TABLE "replies" DROP CONSTRAINT "replies_status_check", ADD CONSTRAINT "replies_status_check" CHECK ("status" IN ('admitting', 'running', 'settling', 'completed', 'failed', 'stopped'));