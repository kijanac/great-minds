ALTER TABLE "sessions" ADD COLUMN "kind" text DEFAULT 'session' NOT NULL;--> statement-breakpoint
UPDATE "sessions" SET "kind" = 'btw' WHERE "origin"->>'anchor' IS NOT NULL;--> statement-breakpoint
UPDATE "sessions" SET "origin" = "origin" || '{"kind":"document"}'::jsonb WHERE "origin" IS NOT NULL AND "origin"->>'kind' IS NULL;--> statement-breakpoint
CREATE INDEX "ix_sessions_origin_session_id" ON "sessions" (("origin"->>'session_id')) WHERE "origin"->>'kind' = 'answer';--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_kind_check" CHECK ("kind" IN ('session', 'btw'));--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_btw_origin_check" CHECK ("kind" != 'btw' OR "origin"->>'anchor' IS NOT NULL);
