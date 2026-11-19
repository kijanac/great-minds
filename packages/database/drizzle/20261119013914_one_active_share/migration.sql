UPDATE "shares" SET "revoked_at" = "expires_at"
WHERE "revoked_at" IS NULL AND "expires_at" IS NOT NULL AND "expires_at" <= now();--> statement-breakpoint
UPDATE "shares" SET "revoked_at" = now()
WHERE "revoked_at" IS NULL AND "id" NOT IN (
  SELECT DISTINCT ON ("created_by", "subject_kind", "subject_id") "id"
  FROM "shares" WHERE "revoked_at" IS NULL
  ORDER BY "created_by", "subject_kind", "subject_id", "created_at" DESC, "id" DESC
);--> statement-breakpoint
ALTER TABLE "shares" DROP COLUMN "expires_at";--> statement-breakpoint
CREATE UNIQUE INDEX "uq_shares_active_subject" ON "shares" ("created_by","subject_kind","subject_id") WHERE "revoked_at" IS NULL;
