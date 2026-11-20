CREATE INDEX IF NOT EXISTS "ix_search_index_embedding_half" ON "search_index" USING hnsw (("embedding"::halfvec(1024)) halfvec_cosine_ops);
