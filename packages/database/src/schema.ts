import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
  vector,
} from "drizzle-orm/pg-core";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

export const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return "tsvector";
  },
});

export const memberRole = pgEnum("member_role", ["OWNER", "EDITOR", "VIEWER"]);
export const proposalStatus = pgEnum("proposal_status", ["PENDING", "APPROVED", "REJECTED"]);

export const authCodes = pgTable(
  "auth_codes",
  {
    id: uuid("id").primaryKey(),
    email: varchar("email", { length: 320 }).notNull(),
    codeHash: varchar("code_hash", { length: 64 }).notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    used: boolean("used").notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
  },
  (table) => [index("ix_auth_codes_email").on(table.email)],
);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey(),
    email: varchar("email", { length: 320 }).notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    r2BucketName: text("r2_bucket_name"),
  },
  (table) => [uniqueIndex("ix_users_email").on(table.email)],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull(),
    keyHash: varchar("key_hash", { length: 64 }).notNull(),
    label: text("label").notNull(),
    revoked: boolean("revoked").notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: "api_keys_user_id_fkey",
    }).onDelete("cascade"),
    uniqueIndex("ix_api_keys_key_hash").on(table.keyHash),
  ],
);

export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    revoked: boolean("revoked").notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: "refresh_tokens_user_id_fkey",
    }).onDelete("cascade"),
    uniqueIndex("ix_refresh_tokens_token_hash").on(table.tokenHash),
  ],
);

export const webauthnCredentials = pgTable(
  "webauthn_credentials",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull(),
    credentialId: text("credential_id").notNull(),
    publicKey: text("public_key").notNull(),
    signCount: bigint("sign_count", { mode: "number" }).default(0).notNull(),
    transports: text("transports")
      .array()
      .default(sql`'{}'::text[]`)
      .notNull(),
    name: text("name").notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    lastUsedAt: timestamptz("last_used_at"),
  },
  (table) => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: "webauthn_credentials_user_id_fkey",
    }).onDelete("cascade"),
    unique("uq_webauthn_credentials_credential_id").on(table.credentialId),
  ],
);

export const webauthnChallenges = pgTable(
  "webauthn_challenges",
  {
    challenge: text("challenge").primaryKey(),
    kind: text("kind").notNull(),
    userId: uuid("user_id"),
    expiresAt: timestamptz("expires_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: "webauthn_challenges_user_id_fkey",
    }).onDelete("cascade"),
    check("ck_webauthn_challenges_kind", sql`${table.kind} in ('registration', 'authentication')`),
  ],
);

export const vaults = pgTable(
  "vaults",
  {
    id: uuid("id").primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    ownerId: uuid("owner_id").notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    r2BucketName: text("r2_bucket_name"),
  },
  (table) => [
    foreignKey({
      columns: [table.ownerId],
      foreignColumns: [users.id],
      name: "vaults_owner_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const compileCacheEntries = pgTable(
  "compile_cache_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    vaultId: uuid("vault_id").notNull(),
    phase: text("phase").notNull(),
    cacheKey: text("cache_key").notNull(),
    value: jsonb("value").notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.vaultId],
      foreignColumns: [vaults.id],
      name: "compile_cache_entries_vault_id_fkey",
    }).onDelete("cascade"),
    unique("compile_cache_entries_vault_id_phase_cache_key_key").on(
      table.vaultId,
      table.phase,
      table.cacheKey,
    ),
    index("ix_compile_cache_entries_vault_id").on(table.vaultId),
  ],
);

export const llmCostEvents = pgTable(
  "llm_cost_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    userId: uuid("user_id"),
    vaultId: uuid("vault_id"),
    eventType: text("event_type").notNull(),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull(),
    correlationId: text("correlation_id"),
  },
  (table) => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: "llm_cost_events_user_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.vaultId],
      foreignColumns: [vaults.id],
      name: "llm_cost_events_vault_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const vaultMemberships = pgTable(
  "vault_memberships",
  {
    id: uuid("id").primaryKey(),
    vaultId: uuid("vault_id").notNull(),
    userId: uuid("user_id").notNull(),
    role: memberRole("role").notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.vaultId],
      foreignColumns: [vaults.id],
      name: "vault_memberships_vault_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: "vault_memberships_user_id_fkey",
    }).onDelete("cascade"),
    unique("vault_memberships_vault_id_user_id_key").on(table.vaultId, table.userId),
  ],
);

export const pipelineRuns = pgTable(
  "pipeline_runs",
  {
    id: uuid("id").primaryKey(),
    vaultId: uuid("vault_id").notNull(),
    trigger: text("trigger").notNull(),
    status: text("status").notNull(),
    currentPhase: text("current_phase").notNull(),
    phaseStatus: text("phase_status").notNull(),
    progressSteps: jsonb("progress_steps")
      .default(sql`'[]'::jsonb`)
      .notNull(),
    error: text("error"),
    ingestTaskId: uuid("ingest_task_id"),
    compileIntentId: uuid("compile_intent_id"),
    compileTaskId: uuid("compile_task_id"),
    activeTaskId: uuid("active_task_id"),
    activeTaskType: text("active_task_type"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at").defaultNow().notNull(),
    completedAt: timestamptz("completed_at"),
  },
  (table) => [
    foreignKey({
      columns: [table.vaultId],
      foreignColumns: [vaults.id],
      name: "pipeline_runs_vault_id_fkey",
    }).onDelete("cascade"),
    index("ix_pipeline_runs_vault_id").on(table.vaultId),
  ],
);

export const compileIntents = pgTable(
  "compile_intents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    vaultId: uuid("vault_id").notNull(),
    pipelineRunId: uuid("pipeline_run_id"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    dispatchedAt: timestamptz("dispatched_at"),
    dispatchedTaskId: uuid("dispatched_task_id"),
    satisfiedAt: timestamptz("satisfied_at"),
  },
  (table) => [
    foreignKey({
      columns: [table.vaultId],
      foreignColumns: [vaults.id],
      name: "compile_intents_vault_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.pipelineRunId],
      foreignColumns: [pipelineRuns.id],
      name: "compile_intents_pipeline_run_id_fkey",
    }).onDelete("set null"),
    uniqueIndex("ix_compile_intents_one_pending")
      .on(table.vaultId)
      .where(sql`${table.dispatchedAt} IS NULL`),
    index("ix_compile_intents_pending")
      .on(table.createdAt)
      .where(sql`${table.dispatchedAt} IS NULL`),
    index("ix_compile_intents_pipeline_run_id").on(table.pipelineRunId),
  ],
);

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey(),
    vaultId: uuid("vault_id").notNull(),
    type: text("type").notNull(),
    params: jsonb("params").notNull(),
    pipelineRunId: uuid("pipeline_run_id"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.vaultId],
      foreignColumns: [vaults.id],
      name: "tasks_vault_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.pipelineRunId],
      foreignColumns: [pipelineRuns.id],
      name: "tasks_pipeline_run_id_fkey",
    }).onDelete("set null"),
    index("ix_tasks_vault_id").on(table.vaultId),
    index("ix_tasks_pipeline_run_id").on(table.pipelineRunId),
  ],
);

export const searchIndex = pgTable(
  "search_index",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    vaultId: uuid("vault_id").notNull(),
    path: text("path").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    heading: text("heading").notNull(),
    body: text("body").notNull(),
    contentHash: text("content_hash").notNull(),
    tsv: tsvector("tsv").notNull(),
    embedding: vector("embedding", { dimensions: 1024 }),
    updatedAt: timestamptz("updated_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.vaultId],
      foreignColumns: [vaults.id],
      name: "search_index_vault_id_fkey",
    }).onDelete("cascade"),
    unique("search_index_vault_id_path_chunk_index_key").on(
      table.vaultId,
      table.path,
      table.chunkIndex,
    ),
    index("ix_search_index_vault_id").on(table.vaultId),
    index("ix_search_index_tsv").using("gin", table.tsv),
    index("ix_search_index_embedding").using("hnsw", table.embedding.op("vector_cosine_ops")),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").notNull(),
    vaultId: uuid("vault_id").notNull(),
    userId: uuid("user_id").notNull(),
    query: text("query").notNull(),
    origin: jsonb("origin"),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
    idempotencyKey: text("idempotency_key"),
  },
  (table) => [
    foreignKey({
      columns: [table.vaultId],
      foreignColumns: [vaults.id],
      name: "sessions_vault_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: "sessions_user_id_fkey",
    }).onDelete("cascade"),
    primaryKey({ columns: [table.id, table.vaultId] }),
    unique("uq_sessions_vault_idempotency").on(table.vaultId, table.idempotencyKey),
    index("ix_sessions_updated_at").on(table.updatedAt),
    index("ix_sessions_user_id").on(table.userId),
    index("ix_sessions_vault_id").on(table.vaultId),
  ],
);

export const replies = pgTable(
  "replies",
  {
    id: uuid("id").primaryKey(),
    vaultId: uuid("vault_id").notNull(),
    userId: uuid("user_id").notNull(),
    sessionId: text("session_id"),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    answer: text("answer").default("").notNull(),
    sources: jsonb("sources")
      .default(sql`'[]'::jsonb`)
      .notNull(),
    error: text("error"),
    version: integer("version").default(0).notNull(),
    request: jsonb("request").notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.vaultId],
      foreignColumns: [vaults.id],
      name: "replies_vault_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: "replies_user_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.sessionId, table.vaultId],
      foreignColumns: [sessions.id, sessions.vaultId],
      name: "replies_session_id_vault_id_fkey",
    }).onDelete("cascade"),
    index("ix_replies_vault_id").on(table.vaultId),
    index("ix_replies_user_id").on(table.userId),
    index("ix_replies_session_id").on(table.sessionId),
    index("ix_replies_running_updated_at")
      .on(table.updatedAt)
      .where(sql`${table.status} = 'running'`),
    check("replies_kind_check", sql`${table.kind} IN ('exchange', 'btw', 'ephemeral')`),
    check("replies_status_check", sql`${table.status} IN ('running', 'completed', 'failed')`),
  ],
);

export const sourceDocuments = pgTable(
  "source_documents",
  {
    id: uuid("id").primaryKey(),
    vaultId: uuid("vault_id").notNull(),
    filePath: text("file_path").notNull(),
    fileHash: text("file_hash").notNull(),
    bodyHash: text("body_hash").notNull(),
    clientHash: text("client_hash"),
    etag: text("etag"),
    sourceType: text("source_type").notNull(),
    url: text("url"),
    origin: text("origin"),
    provenanceSessionId: uuid("provenance_session_id"),
    provenanceExchangeId: text("provenance_exchange_id"),
    provenanceSessionQuery: text("provenance_session_query"),
    provenanceSourceDocPath: text("provenance_source_doc_path"),
    provenanceSourceAnchor: text("provenance_source_anchor"),
    provenanceSourceParagraphIndex: integer("provenance_source_paragraph_index"),
    provenanceAnchoredTo: text("provenance_anchored_to"),
    provenanceAnchoredSection: text("provenance_anchored_section"),
    provenanceIntent: text("provenance_intent"),
    title: text("title"),
    precis: text("precis"),
    author: text("author"),
    publishedDate: text("published_date"),
    genre: text("genre"),
    tags: text("tags")
      .array()
      .default(sql`ARRAY[]::text[]`)
      .notNull(),
    derivedExtras: jsonb("derived_extras")
      .default(sql`'{}'::jsonb`)
      .notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.vaultId],
      foreignColumns: [vaults.id],
      name: "source_documents_vault_id_fkey",
    }).onDelete("cascade"),
    unique("source_documents_vault_id_file_path_key").on(table.vaultId, table.filePath),
    index("ix_source_documents_vault_client_hash")
      .on(table.vaultId, table.clientHash)
      .where(sql`${table.clientHash} IS NOT NULL`),
    index("ix_source_documents_vault_id").on(table.vaultId),
  ],
);

export const userDocuments = pgTable(
  "user_documents",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull(),
    filePath: text("file_path").notNull(),
    fileHash: text("file_hash").notNull(),
    bodyHash: text("body_hash").notNull(),
    title: text("title"),
    url: text("url"),
    origin: text("origin"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: "user_documents_user_id_fkey",
    }).onDelete("cascade"),
    unique("user_documents_user_id_file_path_key").on(table.userId, table.filePath),
    index("ix_user_documents_user_id").on(table.userId),
  ],
);

export const sourceProposals = pgTable(
  "source_proposals",
  {
    id: uuid("id").primaryKey(),
    vaultId: uuid("vault_id").notNull(),
    userId: uuid("user_id").notNull(),
    status: proposalStatus("status").notNull(),
    contentType: varchar("content_type", { length: 50 }).notNull(),
    title: text("title"),
    author: text("author"),
    destPath: text("dest_path").default("").notNull(),
    documentId: uuid("document_id"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.vaultId],
      foreignColumns: [vaults.id],
      name: "source_proposals_vault_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: "source_proposals_user_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.documentId],
      foreignColumns: [sourceDocuments.id],
      name: "source_proposals_document_id_fkey",
    }).onDelete("set null"),
    index("ix_source_proposals_document_id").on(table.documentId),
    index("ix_source_proposals_vault_id").on(table.vaultId),
  ],
);

export const ideas = pgTable(
  "ideas",
  {
    ideaId: uuid("idea_id").primaryKey(),
    vaultId: uuid("vault_id").notNull(),
    documentId: uuid("document_id").notNull(),
    kind: text("kind").notNull(),
    label: text("label").notNull(),
    description: text("description").notNull(),
    embedding: vector("embedding", { dimensions: 1024 }),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.vaultId],
      foreignColumns: [vaults.id],
      name: "ideas_vault_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.documentId],
      foreignColumns: [sourceDocuments.id],
      name: "ideas_document_id_fkey",
    }).onDelete("cascade"),
    index("ix_ideas_vault_id").on(table.vaultId),
    index("ix_ideas_document_id").on(table.documentId),
  ],
);

export const anchors = pgTable(
  "anchors",
  {
    ideaId: uuid("idea_id").notNull(),
    position: integer("position").notNull(),
    claim: text("claim").notNull(),
    quote: text("quote").notNull(),
    chunkIndex: integer("chunk_index"),
  },
  (table) => [
    foreignKey({
      columns: [table.ideaId],
      foreignColumns: [ideas.ideaId],
      name: "anchors_idea_id_fkey",
    }).onDelete("cascade"),
    primaryKey({ columns: [table.ideaId, table.position] }),
  ],
);

export const topics = pgTable(
  "topics",
  {
    topicId: uuid("topic_id").primaryKey(),
    vaultId: uuid("vault_id").notNull(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    articleStatus: text("article_status").default("no_article").notNull(),
    compiledFromHash: text("compiled_from_hash"),
    renderedFromHash: text("rendered_from_hash"),
    supersedes: uuid("supersedes"),
    supersededBy: uuid("superseded_by"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.vaultId],
      foreignColumns: [vaults.id],
      name: "topics_vault_id_fkey",
    }).onDelete("cascade"),
    check(
      "ck_topics_article_status",
      sql`${table.articleStatus} in ('no_article', 'rendered', 'needs_revision', 'archived')`,
    ),
    index("ix_topics_vault_id").on(table.vaultId),
    unique("topics_vault_id_slug_key").on(table.vaultId, table.slug),
  ],
);

export const topicMembership = pgTable(
  "topic_membership",
  {
    topicId: uuid("topic_id").notNull(),
    ideaId: uuid("idea_id").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.topicId],
      foreignColumns: [topics.topicId],
      name: "topic_membership_topic_id_fkey",
    }).onDelete("cascade"),
    primaryKey({ columns: [table.topicId, table.ideaId] }),
  ],
);

export const topicLinks = pgTable(
  "topic_links",
  {
    sourceTopicId: uuid("source_topic_id").notNull(),
    targetTopicId: uuid("target_topic_id").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.sourceTopicId],
      foreignColumns: [topics.topicId],
      name: "topic_links_source_topic_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.targetTopicId],
      foreignColumns: [topics.topicId],
      name: "topic_links_target_topic_id_fkey",
    }).onDelete("cascade"),
    primaryKey({ columns: [table.sourceTopicId, table.targetTopicId] }),
  ],
);

export const topicRelated = pgTable(
  "topic_related",
  {
    topicId: uuid("topic_id").notNull(),
    relatedTopicId: uuid("related_topic_id").notNull(),
    sharedIdeas: integer("shared_ideas").notNull(),
    jaccard: doublePrecision("jaccard").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.topicId],
      foreignColumns: [topics.topicId],
      name: "topic_related_topic_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.relatedTopicId],
      foreignColumns: [topics.topicId],
      name: "topic_related_related_topic_id_fkey",
    }).onDelete("cascade"),
    primaryKey({ columns: [table.topicId, table.relatedTopicId] }),
  ],
);

export const wikiArticles = pgTable(
  "wiki_articles",
  {
    id: uuid("id").primaryKey(),
    vaultId: uuid("vault_id").notNull(),
    topicId: uuid("topic_id").notNull(),
    filePath: text("file_path").notNull(),
    fileHash: text("file_hash").notNull(),
    bodyHash: text("body_hash").notNull(),
    title: text("title").notNull(),
    precis: text("precis").notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at").defaultNow().notNull(),
    renderRunId: uuid("render_run_id"),
    archived: boolean("archived").default(false).notNull(),
    tags: text("tags")
      .array()
      .default(sql`ARRAY[]::text[]`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.vaultId],
      foreignColumns: [vaults.id],
      name: "wiki_articles_vault_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.topicId],
      foreignColumns: [topics.topicId],
      name: "wiki_articles_topic_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.renderRunId],
      foreignColumns: [pipelineRuns.id],
      name: "fk_wiki_articles_render_run_id_pipeline_runs",
    }).onDelete("set null"),
    unique("wiki_articles_topic_id_key").on(table.topicId),
    index("ix_wiki_articles_vault_id").on(table.vaultId),
    index("ix_wiki_articles_render_run_id")
      .on(table.renderRunId)
      .where(sql`${table.renderRunId} IS NOT NULL`),
  ],
);

export const backlinks = pgTable(
  "backlinks",
  {
    sourceArticleId: uuid("source_article_id").notNull(),
    targetArticleId: uuid("target_article_id").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.sourceArticleId],
      foreignColumns: [wikiArticles.id],
      name: "backlinks_source_article_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.targetArticleId],
      foreignColumns: [wikiArticles.id],
      name: "backlinks_target_article_id_fkey",
    }).onDelete("cascade"),
    primaryKey({ columns: [table.sourceArticleId, table.targetArticleId] }),
  ],
);
