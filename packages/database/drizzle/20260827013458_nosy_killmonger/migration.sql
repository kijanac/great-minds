CREATE TABLE "url_ingest_requests" (
	"id" uuid PRIMARY KEY,
	"created_by" uuid NOT NULL,
	"canonical_url" text NOT NULL,
	"origin" text,
	"dispatched_at" timestamp with time zone,
	"dispatched_task_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "ix_replies_running_updated_at";--> statement-breakpoint
ALTER TABLE "replies" ADD COLUMN "dispatched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "replies" ADD COLUMN "dispatched_task_id" uuid;--> statement-breakpoint
CREATE INDEX "ix_replies_pending_dispatch" ON "replies" ("created_at") WHERE "status" = 'running' AND "dispatched_at" IS NULL;--> statement-breakpoint
CREATE INDEX "ix_url_ingest_requests_pending" ON "url_ingest_requests" ("created_at") WHERE "dispatched_at" IS NULL;--> statement-breakpoint
ALTER TABLE "url_ingest_requests" ADD CONSTRAINT "url_ingest_requests_id_fkey" FOREIGN KEY ("id") REFERENCES "pipeline_runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "url_ingest_requests" ADD CONSTRAINT "url_ingest_requests_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE CASCADE;