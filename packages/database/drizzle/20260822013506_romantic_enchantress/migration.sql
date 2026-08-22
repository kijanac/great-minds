CREATE TABLE "prompts" (
	"hash" text PRIMARY KEY,
	"content" text NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ideas" ADD COLUMN "embedding_model" text;--> statement-breakpoint
ALTER TABLE "llm_cost_events" ADD COLUMN "phase" text;--> statement-breakpoint
ALTER TABLE "llm_cost_events" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "llm_cost_events" ADD COLUMN "prompt_hash" text;--> statement-breakpoint
ALTER TABLE "llm_cost_events" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "llm_cost_events" ADD COLUMN "prompt_tokens" integer;--> statement-breakpoint
ALTER TABLE "llm_cost_events" ADD COLUMN "completion_tokens" integer;--> statement-breakpoint
ALTER TABLE "llm_cost_events" ADD COLUMN "generation_id" text;