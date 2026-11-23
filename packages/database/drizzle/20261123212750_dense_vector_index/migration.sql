DROP INDEX IF EXISTS "ix_search_index_embedding_half";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_search_index_embedding_half_m32" ON "search_index" USING hnsw (("embedding"::halfvec(1024)) halfvec_cosine_ops) WITH (m=32, ef_construction=128);
