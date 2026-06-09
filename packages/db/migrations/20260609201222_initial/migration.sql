CREATE TYPE "api_key_scope" AS ENUM('query', 'vaults:read', 'vaults:write', 'sources:read', 'sources:write');--> statement-breakpoint
CREATE TYPE "member_role" AS ENUM('owner', 'editor', 'viewer');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"key_hash" text NOT NULL CONSTRAINT "api_keys_key_hash_unique" UNIQUE,
	"label" text NOT NULL,
	"scopes" "api_key_scope"[] DEFAULT ARRAY['query']::"api_key_scope"[] NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"email" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"email" text NOT NULL UNIQUE,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vault_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"vault_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "member_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vault_memberships_vault_id_user_id_unique" UNIQUE("vault_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "vaults" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"thematic_hint" text DEFAULT '' NOT NULL,
	"kinds" text[] DEFAULT ARRAY['person', 'event', 'organization', 'concept']::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "api_keys_user_id_idx" ON "api_keys" ("user_id");--> statement-breakpoint
CREATE INDEX "auth_codes_email_idx" ON "auth_codes" ("email");--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens" ("user_id");--> statement-breakpoint
CREATE INDEX "source_documents_vault_id_source_type_idx" ON "source_documents" ("vault_id","source_type");--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "source_documents" ADD CONSTRAINT "source_documents_vault_id_vaults_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vault_memberships" ADD CONSTRAINT "vault_memberships_vault_id_vaults_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vault_memberships" ADD CONSTRAINT "vault_memberships_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vaults" ADD CONSTRAINT "vaults_owner_id_users_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE;