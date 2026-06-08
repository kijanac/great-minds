ALTER TABLE "vaults" ADD COLUMN "thematic_hint" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "vaults" ADD COLUMN "kinds" text[] DEFAULT ARRAY[]::text[] NOT NULL;