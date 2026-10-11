ALTER TABLE "sessions" DROP CONSTRAINT "sessions_kind_check";--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_btw_origin_check";--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "placement" text DEFAULT 'standalone' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "reply_mode" text DEFAULT 'query' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "sessions" SET "placement" = CASE WHEN "kind" = 'btw' THEN 'inline' ELSE 'standalone' END, "reply_mode" = CASE WHEN "kind" = 'btw' THEN 'btw' ELSE 'query' END;--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "kind";--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_placement_check" CHECK ("placement" IN ('inline', 'standalone'));--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_reply_mode_check" CHECK ("reply_mode" IN ('btw', 'query'));--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_revision_check" CHECK ("revision" >= 0);--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_inline_origin_check" CHECK ("placement" != 'inline' OR "origin"->>'anchor' IS NOT NULL);