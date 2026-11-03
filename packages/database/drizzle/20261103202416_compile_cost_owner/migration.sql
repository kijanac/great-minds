UPDATE "llm_cost_events" AS "event"
SET "user_id" = "vault"."owner_id"
FROM "vaults" AS "vault"
WHERE "event"."vault_id" = "vault"."id"
  AND "event"."event_type" = 'compile'
  AND "event"."user_id" IS NULL;
