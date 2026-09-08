DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "replies" WHERE "session_id" IS NULL OR "kind" = 'ephemeral') THEN
    RAISE EXCEPTION 'Historical sessionless replies require review before migrating reply requests';
  END IF;
END $$;--> statement-breakpoint
UPDATE "replies"
SET "request" = ("request" - 'kind' - 'create' - 'session_id' - 'btw') || jsonb_build_object(
  'session', CASE
    WHEN "request" ? 'create' THEN ("request"->'create') || '{"kind":"new"}'::jsonb
    ELSE jsonb_build_object('kind', 'existing', 'id', "session_id") || CASE
      WHEN "kind" = 'btw' THEN jsonb_build_object('btw', "request"->'btw')
      ELSE '{}'::jsonb
    END
  END
)
WHERE "request" ? 'kind';--> statement-breakpoint
ALTER TABLE "replies" ALTER COLUMN "session_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "replies" DROP CONSTRAINT "replies_kind_check", ADD CONSTRAINT "replies_kind_check" CHECK ("kind" IN ('exchange', 'btw'));
