ALTER TABLE "pipeline_runs" ADD COLUMN "stages" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD COLUMN "warnings" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
UPDATE "pipeline_runs"
SET "stages" = jsonb_build_array(jsonb_build_object('phase', "current_phase", 'steps', "progress_steps"))
WHERE "current_phase" <> '';--> statement-breakpoint
UPDATE "pipeline_runs"
SET "warnings" = (
    SELECT jsonb_agg(
      jsonb_build_object(
        'phase', CASE
          WHEN part LIKE '%documents could not be read%' AND part NOT LIKE '%for topics%' THEN 'extract'
          WHEN part LIKE '%articles could not be written%' OR part LIKE '%link questions failed%' THEN 'render'
          ELSE 'abstract'
        END,
        'message', coalesce((regexp_match(part, '^\d+ (.*)$'))[1], part),
        'count', coalesce((regexp_match(part, '^(\d+) '))[1]::integer, 0),
        'items', '[]'::jsonb
      )
      ORDER BY position
    )
    FROM unnest(string_to_array("error", '; ')) WITH ORDINALITY AS split(part, position)
  ),
  "error" = NULL
WHERE "status" IN ('completed', 'running', 'pending') AND "error" IS NOT NULL;--> statement-breakpoint
DROP TRIGGER "pipeline_runs_notify_update" ON "pipeline_runs";--> statement-breakpoint
DROP TRIGGER "pipeline_runs_notify_insert" ON "pipeline_runs";--> statement-breakpoint
DROP FUNCTION "notify_pipeline_run_changed"();--> statement-breakpoint
ALTER TABLE "pipeline_runs" DROP COLUMN "progress_steps";
