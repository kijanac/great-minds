UPDATE "replies" AS r
SET "request" = jsonb_build_object(
  'command', CASE
    WHEN jsonb_typeof(r."request"->'header') = 'object' AND s."origin" IS NOT NULL
      THEN jsonb_set((r."request"->'command') - 'model' - 'extra_instructions', '{session,origin}', s."origin")
    ELSE (r."request"->'command') - 'model' - 'extra_instructions'
  END,
  'mode', r."request"->'mode',
  'accepted_at', r."request"->'attempt'->'accepted_at',
  'previous_attempt_id', r."request"->'attempt'->'previous_attempt_id',
  'parent_reply_id', r."request"->'attempt'->'parent_reply_id',
  'conversation', CASE
    WHEN jsonb_typeof(r."request"->'header') = 'object'
      THEN jsonb_build_object(
        'created_at', r."request"->'header'->'created_at',
        'anchor_reply_id', r."request"->'header'->'anchor_reply_id',
        'context', r."request"->'header'->'context'
      )
    ELSE 'null'::jsonb
  END
)
FROM "sessions" AS s
WHERE s."id" = r."session_id" AND s."vault_id" = r."vault_id" AND r."request" ? 'attempt';--> statement-breakpoint
ALTER TABLE "replies" DROP CONSTRAINT "replies_active_generation_check";--> statement-breakpoint
ALTER TABLE "replies" DROP COLUMN "dispatched_task_id";--> statement-breakpoint
ALTER TABLE "replies" DROP COLUMN "active_generation_kind";--> statement-breakpoint
ALTER TABLE "replies" DROP COLUMN "active_generation_key";