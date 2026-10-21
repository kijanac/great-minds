DO $$
DECLARE
  inconsistent text;
BEGIN
  SELECT string_agg(owner_check.id::text, ', ' ORDER BY owner_check.id)
    INTO inconsistent
    FROM (
      SELECT v.id
        FROM "vaults" v
        LEFT JOIN "vault_memberships" m ON m."vault_id" = v."id" AND m."role" = 'OWNER'
       GROUP BY v."id", v."owner_id"
      HAVING count(m."id") <> 1
          OR count(m."id") FILTER (WHERE m."user_id" = v."owner_id") <> 1
    ) owner_check;
  IF inconsistent IS NOT NULL THEN
    RAISE EXCEPTION 'Vault ownership migration requires every vault to have exactly one OWNER membership matching vaults.owner_id'
      USING DETAIL = 'Inconsistent vaults: ' || inconsistent;
  END IF;
END $$;--> statement-breakpoint
CREATE TYPE "proposal_outcome" AS ENUM('APPLIED', 'SOURCE_ENDED');--> statement-breakpoint
DROP INDEX "ix_auth_codes_email";--> statement-breakpoint
ALTER TABLE "auth_codes" ADD COLUMN "failed_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_codes" ADD COLUMN "client_address" text;--> statement-breakpoint
ALTER TABLE "source_proposals" ADD COLUMN "outcome" "proposal_outcome";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vaults" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vault_memberships" ALTER COLUMN "role" SET DATA TYPE text;--> statement-breakpoint
UPDATE "vault_memberships" SET "role" = 'EDITOR' WHERE "role" = 'OWNER';--> statement-breakpoint
DROP TYPE "member_role";--> statement-breakpoint
CREATE TYPE "member_role" AS ENUM('EDITOR', 'VIEWER');--> statement-breakpoint
ALTER TABLE "vault_memberships" ALTER COLUMN "role" SET DATA TYPE "member_role" USING "role"::"member_role";--> statement-breakpoint
ALTER TABLE "vaults" ADD CONSTRAINT "vaults_owner_membership_fkey" FOREIGN KEY ("id", "owner_id") REFERENCES "vault_memberships" ("vault_id", "user_id") DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
CREATE INDEX "ix_auth_codes_email_created_at" ON "auth_codes" ("email","created_at");--> statement-breakpoint
CREATE INDEX "ix_auth_codes_client_address_created_at" ON "auth_codes" ("client_address","created_at") WHERE "client_address" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_users_deleted_at" ON "users" ("deleted_at") WHERE "deleted_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_vaults_owner_id" ON "vaults" ("owner_id");--> statement-breakpoint
CREATE INDEX "ix_vaults_deleted_at" ON "vaults" ("deleted_at") WHERE "deleted_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_codes" ADD CONSTRAINT "ck_auth_codes_failed_attempts" CHECK ("failed_attempts" >= 0);--> statement-breakpoint
ALTER TABLE "source_proposals" ADD CONSTRAINT "source_proposals_outcome" CHECK (("outcome" IS NOT NULL) = ("status" = 'APPROVED' AND "completed_at" IS NOT NULL));
