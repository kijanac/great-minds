ALTER TABLE "users" ADD COLUMN "sponsored" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "users" SET "sponsored" = true;