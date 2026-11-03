CREATE TABLE "topic_candidates" (
	"vault_id" uuid NOT NULL,
	"lower_id" uuid,
	"higher_id" uuid,
	"similarity" double precision NOT NULL,
	CONSTRAINT "topic_candidates_pkey" PRIMARY KEY("lower_id","higher_id"),
	CONSTRAINT "topic_candidates_ordered" CHECK ("lower_id" < "higher_id")
);
--> statement-breakpoint
CREATE TABLE "topic_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"vault_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"ask_key" text NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"inclusion_test" text NOT NULL,
	"idea_ids" uuid[] NOT NULL,
	"embedding" halfvec(1024) NOT NULL,
	"paired" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topic_proposals_document_answer_position_key" UNIQUE("document_id","ask_key","position")
);
--> statement-breakpoint
CREATE INDEX "ix_topic_candidates_vault_id" ON "topic_candidates" ("vault_id");--> statement-breakpoint
CREATE INDEX "ix_topic_candidates_higher_id" ON "topic_candidates" ("higher_id");--> statement-breakpoint
CREATE INDEX "ix_topic_proposals_vault_id" ON "topic_proposals" ("vault_id");--> statement-breakpoint
ALTER TABLE "topic_candidates" ADD CONSTRAINT "topic_candidates_lower_id_fkey" FOREIGN KEY ("lower_id") REFERENCES "topic_proposals"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "topic_candidates" ADD CONSTRAINT "topic_candidates_higher_id_fkey" FOREIGN KEY ("higher_id") REFERENCES "topic_proposals"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "topic_proposals" ADD CONSTRAINT "topic_proposals_vault_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "topic_proposals" ADD CONSTRAINT "topic_proposals_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "source_documents"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "topic_proposals" ALTER COLUMN "embedding" SET STORAGE PLAIN;
