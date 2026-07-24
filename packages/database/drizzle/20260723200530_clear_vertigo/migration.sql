CREATE TABLE "replies" (
	"id" uuid PRIMARY KEY,
	"vault_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" text,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"answer" text DEFAULT '' NOT NULL,
	"sources" jsonb DEFAULT '[]' NOT NULL,
	"error" text,
	"version" integer DEFAULT 0 NOT NULL,
	"request" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "replies_kind_check" CHECK ("kind" IN ('exchange', 'btw', 'ephemeral')),
	CONSTRAINT "replies_status_check" CHECK ("status" IN ('running', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE INDEX "ix_replies_vault_id" ON "replies" ("vault_id");--> statement-breakpoint
CREATE INDEX "ix_replies_user_id" ON "replies" ("user_id");--> statement-breakpoint
CREATE INDEX "ix_replies_session_id" ON "replies" ("session_id");--> statement-breakpoint
CREATE INDEX "ix_replies_running_updated_at" ON "replies" ("updated_at") WHERE "status" = 'running';--> statement-breakpoint
ALTER TABLE "replies" ADD CONSTRAINT "replies_vault_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "replies" ADD CONSTRAINT "replies_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "replies" ADD CONSTRAINT "replies_session_id_vault_id_fkey" FOREIGN KEY ("session_id","vault_id") REFERENCES "sessions"("id","vault_id") ON DELETE CASCADE;