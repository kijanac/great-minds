CREATE FUNCTION pg_temp.passage_origin(origin jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT (origin - 'anchor' - 'paragraph' - 'section' - 'occurrence') || jsonb_build_object(
    'passage',
    CASE
      WHEN coalesce(origin->>'anchor', '') = '' THEN 'null'::jsonb
      ELSE jsonb_build_object(
        'quote', origin->'anchor',
        'context', coalesce(origin->>'paragraph', ''),
        'section', CASE WHEN jsonb_typeof(origin->'section') = 'number' THEN origin->'section' ELSE 'null'::jsonb END,
        'occurrence', CASE WHEN jsonb_typeof(origin->'occurrence') = 'number' THEN origin->'occurrence' ELSE '1'::jsonb END
      )
    END
  )
$$;--> statement-breakpoint
UPDATE "sessions"
SET "origin" = pg_temp.passage_origin("origin")
WHERE "origin" IS NOT NULL AND NOT ("origin" ? 'passage');--> statement-breakpoint
UPDATE "replies"
SET "request" = jsonb_set("request", '{command,session,origin}', pg_temp.passage_origin("request" #> '{command,session,origin}'))
WHERE jsonb_typeof("request" #> '{command,session,origin}') = 'object'
  AND NOT ("request" #> '{command,session,origin}' ? 'passage');--> statement-breakpoint
DROP FUNCTION pg_temp.passage_origin(jsonb);
