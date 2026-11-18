UPDATE "sessions"
SET "origin" = "origin" || '{"origin_scope":"vault"}'::jsonb
WHERE "origin"->>'kind' = 'document' AND NOT ("origin" ? 'origin_scope');--> statement-breakpoint
UPDATE "replies"
SET "request" = "request" #- '{command,session,conversation_kind}' #- '{command,session,origin_scope}'
WHERE "request"->'command'->'session' ? 'conversation_kind' OR "request"->'command'->'session' ? 'origin_scope';--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_placement_check";--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_reply_mode_check";--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_revision_check";--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_inline_origin_check";--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "placement";--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "reply_mode";--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "revision";