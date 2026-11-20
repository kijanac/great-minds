ALTER TABLE "compile_intents" DROP COLUMN "dispatched_task_id";--> statement-breakpoint
ALTER TABLE "pipeline_runs" DROP COLUMN "ingest_task_id";--> statement-breakpoint
ALTER TABLE "pipeline_runs" DROP COLUMN "compile_task_id";--> statement-breakpoint
ALTER TABLE "url_ingest_requests" DROP COLUMN "dispatched_task_id";