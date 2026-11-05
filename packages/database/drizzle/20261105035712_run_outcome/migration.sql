ALTER TABLE "pipeline_runs" ADD COLUMN "outcome" jsonb;--> statement-breakpoint
ALTER TABLE "wiki_articles" ADD COLUMN "added_run_id" uuid;--> statement-breakpoint
ALTER TABLE "wiki_articles" ADD COLUMN "changed_run_id" uuid;--> statement-breakpoint
ALTER TABLE "wiki_articles" ADD COLUMN "archived_run_id" uuid;