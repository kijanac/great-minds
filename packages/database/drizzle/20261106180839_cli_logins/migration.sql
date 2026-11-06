CREATE TABLE "cli_logins" (
	"id" uuid PRIMARY KEY,
	"device_code_hash" varchar(64) NOT NULL,
	"user_code" varchar(8) NOT NULL,
	"computer" text NOT NULL,
	"status" text NOT NULL,
	"user_id" uuid,
	"client_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_cli_logins_status" CHECK ("status" in ('pending', 'approved', 'denied', 'claimed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ix_cli_logins_device_code_hash" ON "cli_logins" ("device_code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "ix_cli_logins_pending_user_code" ON "cli_logins" ("user_code") WHERE "status" = 'pending';--> statement-breakpoint
CREATE INDEX "ix_cli_logins_client_address_created_at" ON "cli_logins" ("client_address","created_at") WHERE "client_address" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "cli_logins" ADD CONSTRAINT "cli_logins_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;