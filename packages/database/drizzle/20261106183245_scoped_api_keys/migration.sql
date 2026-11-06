ALTER TABLE "api_keys" ADD COLUMN "vault_ids" uuid[];--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "can_ask" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "can_change" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "last_used_at" timestamp with time zone;