ALTER TABLE "replies" ADD COLUMN "generation_cursor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "replies" ADD COLUMN "active_generation_step" integer;--> statement-breakpoint
ALTER TABLE "replies" ADD COLUMN "active_generation_kind" text;--> statement-breakpoint
ALTER TABLE "replies" ADD COLUMN "active_generation_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_llm_cost_events_query_correlation" ON "llm_cost_events" ("event_type","correlation_id") WHERE "event_type" = 'query.stream' AND "correlation_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "replies" ADD CONSTRAINT "replies_active_generation_check" CHECK (("active_generation_step" IS NULL AND "active_generation_kind" IS NULL AND "active_generation_key" IS NULL) OR ("active_generation_step" IS NOT NULL AND "active_generation_kind" IN ('model', 'tool') AND "active_generation_key" IS NOT NULL));