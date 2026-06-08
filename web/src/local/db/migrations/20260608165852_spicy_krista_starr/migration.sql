CREATE TABLE "source_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"vault_id" uuid NOT NULL,
	"file_path" text NOT NULL,
	"file_hash" text NOT NULL,
	"body_hash" text NOT NULL,
	"client_hash" text,
	"etag" text,
	"source_type" text DEFAULT 'document' NOT NULL,
	"url" text,
	"origin" text,
	"title" text,
	"precis" text,
	"author" text,
	"published_date" text,
	"genre" text,
	"tags" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"derived_extras" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_documents_vault_id_file_path_unique" UNIQUE("vault_id","file_path")
);
--> statement-breakpoint
CREATE INDEX "source_documents_vault_id_source_type_idx" ON "source_documents" ("vault_id","source_type");--> statement-breakpoint
ALTER TABLE "source_documents" ADD CONSTRAINT "source_documents_vault_id_vaults_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE CASCADE;