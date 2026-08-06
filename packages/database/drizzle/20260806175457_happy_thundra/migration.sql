CREATE TABLE "user_documents" (
	"id" uuid PRIMARY KEY,
	"user_id" uuid NOT NULL,
	"file_path" text NOT NULL,
	"file_hash" text NOT NULL,
	"body_hash" text NOT NULL,
	"title" text,
	"url" text,
	"origin" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_documents_user_id_file_path_key" UNIQUE("user_id","file_path")
);
--> statement-breakpoint
CREATE INDEX "ix_user_documents_user_id" ON "user_documents" ("user_id");--> statement-breakpoint
ALTER TABLE "user_documents" ADD CONSTRAINT "user_documents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;