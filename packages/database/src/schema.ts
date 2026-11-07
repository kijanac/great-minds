import { sql } from "drizzle-orm";
import type {
  FileFingerprint,
  JobResponse,
  PipelineStage,
  PipelineWarning,
  RunOutcome,
  ReplySnapshot,
  SessionId,
  Uuid,
} from "@great-minds/domain";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  doublePrecision,
  foreignKey,
  halfvec,
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
const uuidColumn = (name: string) => uuid(name).$type<Uuid>();
const sessionIdColumn = (name: string) => text(name).$type<SessionId>();

const references = (
  column: AnyPgColumn,
  target: AnyPgColumn,
  name: string,
  onDelete?: "cascade" | "set null",
) => {
  const key = foreignKey({ columns: [column], foreignColumns: [target], name });
  return onDelete === undefined ? key : key.onDelete(onDelete);
};

export const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return "tsvector";
  },
});

export const memberRole = pgEnum("member_role", ["EDITOR", "VIEWER"]);
export const proposalStatus = pgEnum("proposal_status", ["PENDING", "APPROVED", "REJECTED"]);
export const proposalOutcome = pgEnum("proposal_outcome", ["APPLIED", "SOURCE_ENDED"]);
export const fileIngestBatchStatus = pgEnum("file_ingest_batch_status", [
  "uploading",
  "processing",
  "completed",
  "failed",
  "cancelled",
]);
export const fileIngestFileStatus = pgEnum("file_ingest_file_status", [
  "pending",
  "uploaded",
  "processing",
  "completed",
  "failed",
  "cancelled",
]);

export const authCodes = pgTable(
  "auth_codes",
  {
    id: uuidColumn("id").primaryKey(),
    email: varchar("email", { length: 320 }).notNull(),
    codeHash: varchar("code_hash", { length: 64 }).notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    used: boolean("used").notNull(),
    failedAttempts: integer("failed_attempts").default(0).notNull(),
    clientAddress: text("client_address"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("ix_auth_codes_email_created_at").on(table.email, table.createdAt),
    index("ix_auth_codes_client_address_created_at")
      .on(table.clientAddress, table.createdAt)
      .where(sql`${table.clientAddress} IS NOT NULL`),
    check("ck_auth_codes_failed_attempts", sql`${table.failedAttempts} >= 0`),
  ],
);

export const users = pgTable(
  "users",
  {
    id: uuidColumn("id").primaryKey(),
    email: varchar("email", { length: 320 }).notNull(),
    sponsored: boolean("sponsored").notNull().default(false),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    deletedAt: timestamptz("deleted_at"),
  },
  (table) => [
    uniqueIndex("ix_users_email").on(table.email),
    index("ix_users_deleted_at")
      .on(table.deletedAt)
      .where(sql`${table.deletedAt} IS NOT NULL`),
  ],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuidColumn("id").primaryKey(),
    userId: uuidColumn("user_id").notNull(),
    keyHash: varchar("key_hash", { length: 64 }).notNull(),
    label: text("label").notNull(),
    revoked: boolean("revoked").notNull(),
    vaultIds: uuidColumn("vault_ids").array(),
    canAsk: boolean("can_ask").default(true).notNull(),
    canChange: boolean("can_change").default(true).notNull(),
    expiresAt: timestamptz("expires_at"),
    lastUsedAt: timestamptz("last_used_at"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
  },
  (table) => [
    references(table.userId, users.id, "api_keys_user_id_fkey", "cascade"),
    uniqueIndex("ix_api_keys_key_hash").on(table.keyHash),
  ],
);

export const cliLogins = pgTable(
  "cli_logins",
  {
    id: uuidColumn("id").primaryKey(),
    deviceCodeHash: varchar("device_code_hash", { length: 64 }).notNull(),
    userCode: varchar("user_code", { length: 8 }).notNull(),
    computer: text("computer").notNull(),
    status: text("status").notNull(),
    userId: uuidColumn("user_id"),
    clientAddress: text("client_address"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
  },
  (table) => [
    references(table.userId, users.id, "cli_logins_user_id_fkey", "cascade"),
    uniqueIndex("ix_cli_logins_device_code_hash").on(table.deviceCodeHash),
    uniqueIndex("ix_cli_logins_pending_user_code")
      .on(table.userCode)
      .where(sql`${table.status} = 'pending'`),
    index("ix_cli_logins_client_address_created_at")
      .on(table.clientAddress, table.createdAt)
      .where(sql`${table.clientAddress} IS NOT NULL`),
    check(
      "ck_cli_logins_status",
      sql`${table.status} in ('pending', 'approved', 'denied', 'claimed')`,
    ),
  ],
);

export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: uuidColumn("id").primaryKey(),
    userId: uuidColumn("user_id").notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    revoked: boolean("revoked").notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
  },
  (table) => [
    references(table.userId, users.id, "refresh_tokens_user_id_fkey", "cascade"),
    uniqueIndex("ix_refresh_tokens_token_hash").on(table.tokenHash),
  ],
);

export const webauthnCredentials = pgTable(
  "webauthn_credentials",
  {
    id: uuidColumn("id").primaryKey(),
    userId: uuidColumn("user_id").notNull(),
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
    references(table.userId, users.id, "webauthn_credentials_user_id_fkey", "cascade"),
    unique("uq_webauthn_credentials_credential_id").on(table.credentialId),
  ],
);

export const webauthnChallenges = pgTable(
  "webauthn_challenges",
  {
    challenge: text("challenge").primaryKey(),
    kind: text("kind").notNull(),
    userId: uuidColumn("user_id"),
    expiresAt: timestamptz("expires_at").notNull(),
  },
  (table) => [
    references(table.userId, users.id, "webauthn_challenges_user_id_fkey", "cascade"),
    check("ck_webauthn_challenges_kind", sql`${table.kind} in ('registration', 'authentication')`),
  ],
);

export const vaults = pgTable(
  "vaults",
  {
    id: uuidColumn("id").primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    ownerId: uuidColumn("owner_id").notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    deletedAt: timestamptz("deleted_at"),
  },
  (table) => [
    references(table.ownerId, users.id, "vaults_owner_id_fkey", "cascade"),
    index("ix_vaults_owner_id").on(table.ownerId),
    index("ix_vaults_deleted_at")
      .on(table.deletedAt)
      .where(sql`${table.deletedAt} IS NOT NULL`),
  ],
);

export const compileCacheEntries = pgTable(
  "compile_cache_entries",
  {
    id: uuidColumn("id").defaultRandom().primaryKey(),
    vaultId: uuidColumn("vault_id").notNull(),
    phase: text("phase").notNull(),
    cacheKey: text("cache_key").notNull(),
    value: jsonb("value").notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
  },
  (table) => [
    references(table.vaultId, vaults.id, "compile_cache_entries_vault_id_fkey", "cascade"),
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
    id: uuidColumn("id").defaultRandom().primaryKey(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    userId: uuidColumn("user_id"),
    vaultId: uuidColumn("vault_id"),
    eventType: text("event_type").notNull(),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull(),
    correlationId: text("correlation_id"),
    phase: text("phase"),
    model: text("model"),
    promptHash: text("prompt_hash"),
    runId: uuidColumn("run_id"),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    generationId: text("generation_id"),
  },
  (table) => [
    references(table.userId, users.id, "llm_cost_events_user_id_fkey", "set null"),
    references(table.vaultId, vaults.id, "llm_cost_events_vault_id_fkey", "cascade"),
    uniqueIndex("uq_llm_cost_events_query_correlation")
      .on(table.eventType, table.correlationId)
      .where(sql`${table.eventType} = 'query.stream' AND ${table.correlationId} IS NOT NULL`),
  ],
);

export const prompts = pgTable("prompts", {
  hash: text("hash").primaryKey(),
  content: text("content").notNull(),
  firstSeen: timestamptz("first_seen").defaultNow().notNull(),
});

export const vaultMemberships = pgTable(
  "vault_memberships",
  {
    id: uuidColumn("id").primaryKey(),
    vaultId: uuidColumn("vault_id").notNull(),
    userId: uuidColumn("user_id").notNull(),
    role: memberRole("role").notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
  },
  (table) => [
    references(table.vaultId, vaults.id, "vault_memberships_vault_id_fkey", "cascade"),
    references(table.userId, users.id, "vault_memberships_user_id_fkey", "cascade"),
    unique("vault_memberships_vault_id_user_id_key").on(table.vaultId, table.userId),
  ],
);

export const pipelineRuns = pgTable(
  "pipeline_runs",
  {
    id: uuidColumn("id").primaryKey(),
    vaultId: uuidColumn("vault_id").notNull(),
    trigger: text("trigger").$type<JobResponse["trigger"]>().notNull(),
    status: text("status").$type<JobResponse["status"]>().notNull(),
    currentPhase: text("current_phase").notNull(),
    phaseStatus: text("phase_status").notNull(),
    stages: jsonb("stages")
      .$type<readonly PipelineStage[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    warnings: jsonb("warnings")
      .$type<readonly PipelineWarning[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    outcome: jsonb("outcome").$type<RunOutcome>(),
    error: text("error"),
    ingestTaskId: uuidColumn("ingest_task_id"),
    compileIntentId: uuidColumn("compile_intent_id"),
    compileTaskId: uuidColumn("compile_task_id"),
    activeTaskId: uuidColumn("active_task_id"),
    activeTaskType: text("active_task_type"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at").defaultNow().notNull(),
    completedAt: timestamptz("completed_at"),
  },
  (table) => [
    references(table.vaultId, vaults.id, "pipeline_runs_vault_id_fkey", "cascade"),
    index("ix_pipeline_runs_vault_id").on(table.vaultId),
    index("ix_pipeline_runs_compile_intent_id").on(table.compileIntentId),
  ],
);

export const fileIngestBatches = pgTable(
  "file_ingest_batches",
  {
    id: uuidColumn("id").primaryKey(),
    createdBy: uuidColumn("created_by").notNull(),
    status: fileIngestBatchStatus("status").notNull(),
    error: text("error"),
    expiresAt: timestamptz("expires_at").notNull(),
    committedAt: timestamptz("committed_at"),
    completedAt: timestamptz("completed_at"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at").defaultNow().notNull(),
  },
  (table) => [
    references(table.id, pipelineRuns.id, "file_ingest_batches_id_fkey", "cascade"),
    references(table.createdBy, users.id, "file_ingest_batches_created_by_fkey", "cascade"),
    index("ix_file_ingest_batches_status_expires_at").on(table.status, table.expiresAt),
  ],
);

export const fileIngestFiles = pgTable(
  "file_ingest_files",
  {
    batchId: uuidColumn("batch_id").notNull(),
    hash: varchar("hash", { length: 64 }).notNull(),
    position: integer("position").notNull(),
    name: text("name").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    mimetype: text("mimetype").notNull(),
    needsCompile: boolean("needs_compile").notNull(),
    sourceIncarnationId: uuidColumn("source_incarnation_id"),
    status: fileIngestFileStatus("status").notNull(),
    error: text("error"),
    uploadedAt: timestamptz("uploaded_at"),
    completedAt: timestamptz("completed_at"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at").defaultNow().notNull(),
  },
  (table) => [
    references(table.batchId, fileIngestBatches.id, "file_ingest_files_batch_id_fkey", "cascade"),
    references(
      table.sourceIncarnationId,
      sourceIncarnations.id,
      "file_ingest_files_source_incarnation_id_fkey",
    ),
    primaryKey({ columns: [table.batchId, table.hash] }),
    unique("uq_file_ingest_files_batch_position").on(table.batchId, table.position),
    check("ck_file_ingest_files_position_nonnegative", sql`${table.position} >= 0`),
    check("ck_file_ingest_files_name_nonempty", sql`length(${table.name}) > 0`),
    check("ck_file_ingest_files_size_nonnegative", sql`${table.size} >= 0`),
    check("ck_file_ingest_files_hash_sha256", sql`${table.hash} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const urlIngestRequests = pgTable(
  "url_ingest_requests",
  {
    id: uuidColumn("id").primaryKey(),
    createdBy: uuidColumn("created_by").notNull(),
    canonicalUrl: text("canonical_url").notNull(),
    sourceIncarnationId: uuidColumn("source_incarnation_id"),
    origin: text("origin"),
    dispatchedAt: timestamptz("dispatched_at"),
    dispatchedTaskId: uuidColumn("dispatched_task_id"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at").defaultNow().notNull(),
  },
  (table) => [
    references(table.id, pipelineRuns.id, "url_ingest_requests_id_fkey", "cascade"),
    references(table.createdBy, users.id, "url_ingest_requests_created_by_fkey", "cascade"),
    references(
      table.sourceIncarnationId,
      sourceIncarnations.id,
      "url_ingest_requests_source_incarnation_id_fkey",
    ),
    index("ix_url_ingest_requests_pending")
      .on(table.createdAt)
      .where(sql`${table.dispatchedAt} IS NULL`),
  ],
);

export const compileIntents = pgTable(
  "compile_intents",
  {
    id: uuidColumn("id").defaultRandom().primaryKey(),
    vaultId: uuidColumn("vault_id").notNull(),
    pipelineRunId: uuidColumn("pipeline_run_id"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    dispatchedAt: timestamptz("dispatched_at"),
    dispatchedTaskId: uuidColumn("dispatched_task_id"),
    satisfiedAt: timestamptz("satisfied_at"),
  },
  (table) => [
    references(table.vaultId, vaults.id, "compile_intents_vault_id_fkey", "cascade"),
    references(
      table.pipelineRunId,
      pipelineRuns.id,
      "compile_intents_pipeline_run_id_fkey",
      "set null",
    ),
    uniqueIndex("ix_compile_intents_one_pending")
      .on(table.vaultId)
      .where(sql`${table.dispatchedAt} IS NULL`),
    index("ix_compile_intents_pending")
      .on(table.createdAt)
      .where(sql`${table.dispatchedAt} IS NULL`),
    index("ix_compile_intents_pipeline_run_id").on(table.pipelineRunId),
  ],
);

export const searchIndex = pgTable(
  "search_index",
  {
    id: uuidColumn("id").defaultRandom().primaryKey(),
    vaultId: uuidColumn("vault_id").notNull(),
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
    references(table.vaultId, vaults.id, "search_index_vault_id_fkey", "cascade"),
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
    id: sessionIdColumn("id").notNull(),
    vaultId: uuidColumn("vault_id").notNull(),
    userId: uuidColumn("user_id").notNull(),
    query: text("query").notNull(),
    origin: jsonb("origin"),
    placement: text("placement").$type<"inline" | "standalone">().default("standalone").notNull(),
    replyMode: text("reply_mode").$type<"btw" | "query">().default("query").notNull(),
    revision: integer("revision").default(0).notNull(),
    historySeq: bigint("history_seq", { mode: "number" }),
    historySha256: varchar("history_sha256", { length: 64 }).$type<FileFingerprint>(),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
    idempotencyKey: text("idempotency_key"),
  },
  (table) => [
    references(table.vaultId, vaults.id, "sessions_vault_id_fkey", "cascade"),
    references(table.userId, users.id, "sessions_user_id_fkey", "cascade"),
    primaryKey({ columns: [table.id, table.vaultId] }),
    unique("uq_sessions_vault_idempotency").on(table.vaultId, table.idempotencyKey),
    index("ix_sessions_updated_at").on(table.updatedAt),
    index("ix_sessions_user_id").on(table.userId),
    index("ix_sessions_vault_id").on(table.vaultId),
    index("ix_sessions_origin_doc_path")
      .using("btree", sql`(${table.origin}->>'doc_path')`)
      .where(sql`${table.origin} IS NOT NULL`),
    index("ix_sessions_origin_session_id")
      .using("btree", sql`(${table.origin}->>'session_id')`)
      .where(sql`${table.origin}->>'kind' = 'answer'`),
    check(
      "sessions_history_receipt_check",
      sql`(${table.historySeq} IS NULL AND ${table.historySha256} IS NULL) OR (${table.historySeq} IS NOT NULL AND ${table.historySha256} IS NOT NULL AND ${table.historySeq} BETWEEN 1 AND ${sql.raw(String(Number.MAX_SAFE_INTEGER))} AND ${table.historySha256} ~ '^[0-9a-f]{64}$')`,
    ),
    check("sessions_placement_check", sql`${table.placement} IN ('inline', 'standalone')`),
    check("sessions_reply_mode_check", sql`${table.replyMode} IN ('btw', 'query')`),
    check("sessions_revision_check", sql`${table.revision} >= 0`),
    check(
      "sessions_inline_origin_check",
      sql`${table.placement} != 'inline' OR ${table.origin}->>'anchor' IS NOT NULL`,
    ),
  ],
);

export const replies = pgTable(
  "replies",
  {
    id: uuidColumn("id").primaryKey(),
    vaultId: uuidColumn("vault_id").notNull(),
    userId: uuidColumn("user_id").notNull(),
    sessionId: sessionIdColumn("session_id").notNull(),
    status: text("status").$type<ReplySnapshot["status"]>().notNull(),
    stopRequested: boolean("stop_requested").default(false).notNull(),
    answer: text("answer").default("").notNull(),
    sources: jsonb("sources")
      .$type<ReplySnapshot["sources"]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    error: text("error"),
    version: integer("version").default(0).notNull(),
    request: jsonb("request").notNull(),
    settlement: jsonb("settlement"),
    dispatchedAt: timestamptz("dispatched_at"),
    dispatchedTaskId: uuidColumn("dispatched_task_id"),
    generationCursor: integer("generation_cursor").default(0).notNull(),
    activeGenerationStep: integer("active_generation_step"),
    activeGenerationKind: text("active_generation_kind"),
    activeGenerationKey: text("active_generation_key"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at").defaultNow().notNull(),
  },
  (table) => [
    references(table.vaultId, vaults.id, "replies_vault_id_fkey", "cascade"),
    references(table.userId, users.id, "replies_user_id_fkey", "cascade"),
    foreignKey({
      columns: [table.sessionId, table.vaultId],
      foreignColumns: [sessions.id, sessions.vaultId],
      name: "replies_session_id_vault_id_fkey",
    }).onDelete("cascade"),
    index("ix_replies_vault_id").on(table.vaultId),
    index("ix_replies_user_id").on(table.userId),
    index("ix_replies_session_id").on(table.sessionId),
    index("ix_replies_pending_dispatch")
      .on(table.createdAt)
      .where(sql`${table.status} = 'running' AND ${table.dispatchedAt} IS NULL`),
    index("ix_replies_pending_settlement")
      .on(table.createdAt)
      .where(sql`${table.status} = 'settling'`),
    index("ix_replies_pending_admission")
      .on(table.createdAt)
      .where(sql`${table.status} = 'admitting'`),
    uniqueIndex("uq_replies_live_session")
      .on(table.vaultId, table.sessionId)
      .where(sql`${table.status} IN ('admitting', 'running', 'settling')`),
    check(
      "replies_status_check",
      sql`${table.status} IN ('admitting', 'running', 'settling', 'completed', 'failed', 'stopped')`,
    ),
    check(
      "replies_settlement_check",
      sql`(${table.status} = 'settling') = (${table.settlement} IS NOT NULL)`,
    ),
    check(
      "replies_active_generation_check",
      sql`(${table.activeGenerationStep} IS NULL AND ${table.activeGenerationKind} IS NULL AND ${table.activeGenerationKey} IS NULL) OR (${table.activeGenerationStep} IS NOT NULL AND ${table.activeGenerationKind} IN ('model', 'tool') AND ${table.activeGenerationKey} IS NOT NULL)`,
    ),
  ],
);

export const sourceIncarnations = pgTable(
  "source_incarnations",
  {
    id: uuidColumn("id").defaultRandom().primaryKey(),
    sourceId: uuidColumn("source_id").notNull(),
    vaultId: uuidColumn("vault_id").notNull(),
    filePath: text("file_path").notNull(),
    unversioned: boolean("unversioned").default(false).notNull(),
    deletedAt: timestamptz("deleted_at"),
    legacyCompletedAt: timestamptz("legacy_completed_at"),
    attemptCount: integer("attempt_count").default(0).notNull(),
    lastAttemptAt: timestamptz("last_attempt_at"),
    completedAt: timestamptz("completed_at"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at").defaultNow().notNull(),
  },
  (table) => [
    references(table.vaultId, vaults.id, "source_incarnations_vault_id_fkey", "cascade"),
    unique("source_incarnations_identity").on(table.id, table.sourceId, table.vaultId),
    uniqueIndex("source_incarnations_active_source")
      .on(table.sourceId)
      .where(sql`${table.deletedAt} IS NULL`),
    uniqueIndex("source_incarnations_active_path")
      .on(table.vaultId, table.filePath)
      .where(sql`${table.deletedAt} IS NULL`),
    index("source_incarnations_pending_cleanup")
      .on(table.deletedAt)
      .where(sql`${table.deletedAt} IS NOT NULL AND ${table.completedAt} IS NULL`),
    check(
      "source_incarnations_cleanup_requires_deletion",
      sql`${table.deletedAt} IS NOT NULL OR (${table.attemptCount} = 0 AND ${table.lastAttemptAt} IS NULL AND ${table.completedAt} IS NULL AND ${table.legacyCompletedAt} IS NULL)`,
    ),
  ],
);

export const sourceDocuments = pgTable(
  "source_documents",
  {
    id: uuidColumn("id").primaryKey(),
    vaultId: uuidColumn("vault_id").notNull(),
    incarnationId: uuidColumn("incarnation_id").notNull(),
    filePath: text("file_path").notNull(),
    fileHash: text("file_hash").notNull(),
    bodyHash: text("body_hash").notNull(),
    clientHash: text("client_hash"),
    etag: text("etag"),
    sourceType: text("source_type").notNull(),
    url: text("url"),
    canonicalUrl: text("canonical_url"),
    origin: text("origin"),
    provenanceSessionId: uuid("provenance_session_id").$type<SessionId>(),
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
    references(table.vaultId, vaults.id, "source_documents_vault_id_fkey", "cascade"),
    foreignKey({
      columns: [table.incarnationId, table.id, table.vaultId],
      foreignColumns: [
        sourceIncarnations.id,
        sourceIncarnations.sourceId,
        sourceIncarnations.vaultId,
      ],
      name: "source_documents_incarnation_fkey",
    }),
    unique("source_documents_vault_id_file_path_key").on(table.vaultId, table.filePath),
    uniqueIndex("uq_source_documents_vault_canonical_url")
      .on(table.vaultId, table.canonicalUrl)
      .where(sql`${table.canonicalUrl} IS NOT NULL`),
    index("ix_source_documents_vault_client_hash")
      .on(table.vaultId, table.clientHash)
      .where(sql`${table.clientHash} IS NOT NULL`),
    index("ix_source_documents_vault_id").on(table.vaultId),
  ],
);

export const userDocuments = pgTable(
  "user_documents",
  {
    id: uuidColumn("id").primaryKey(),
    userId: uuidColumn("user_id").notNull(),
    filePath: text("file_path").notNull(),
    fileHash: text("file_hash").notNull(),
    bodyHash: text("body_hash").notNull(),
    title: text("title"),
    url: text("url"),
    origin: text("origin"),
    author: text("author"),
    published: text("published"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at").defaultNow().notNull(),
  },
  (table) => [
    references(table.userId, users.id, "user_documents_user_id_fkey", "cascade"),
    unique("user_documents_user_id_file_path_key").on(table.userId, table.filePath),
    index("ix_user_documents_user_id").on(table.userId),
  ],
);

export const shares = pgTable(
  "shares",
  {
    id: uuidColumn("id").primaryKey(),
    token: text("token").notNull(),
    subjectKind: text("subject_kind").notNull(),
    subjectId: uuidColumn("subject_id").notNull(),
    createdBy: uuidColumn("created_by").notNull(),
    includeAnnotations: boolean("include_annotations").default(false).notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    expiresAt: timestamptz("expires_at"),
    revokedAt: timestamptz("revoked_at"),
  },
  (table) => [
    references(table.createdBy, users.id, "shares_created_by_fkey", "cascade"),
    uniqueIndex("ix_shares_token").on(table.token),
  ],
);

export const sourceProposals = pgTable(
  "source_proposals",
  {
    id: uuidColumn("id").primaryKey(),
    vaultId: uuidColumn("vault_id").notNull(),
    userId: uuidColumn("user_id").notNull(),
    status: proposalStatus("status").notNull(),
    contentType: varchar("content_type", { length: 50 }).notNull(),
    title: text("title"),
    author: text("author"),
    destPath: text("dest_path").notNull(),
    sourceId: uuidColumn("source_id").notNull(),
    sourceIncarnationId: uuidColumn("source_incarnation_id"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    reviewedAt: timestamptz("reviewed_at"),
    completedAt: timestamptz("completed_at"),
    outcome: proposalOutcome("outcome"),
  },
  (table) => [
    references(table.vaultId, vaults.id, "source_proposals_vault_id_fkey", "cascade"),
    references(table.userId, users.id, "source_proposals_user_id_fkey", "cascade"),
    references(
      table.sourceIncarnationId,
      sourceIncarnations.id,
      "source_proposals_source_incarnation_id_fkey",
    ),
    index("ix_source_proposals_source_id").on(table.sourceId),
    index("ix_source_proposals_vault_id").on(table.vaultId),
    index("source_proposals_unfinished_review")
      .on(table.reviewedAt)
      .where(sql`${table.reviewedAt} IS NOT NULL AND ${table.completedAt} IS NULL`),
    check(
      "source_proposals_review_progress",
      sql`(${table.status} <> 'PENDING' OR ${table.reviewedAt} IS NULL) AND (${table.reviewedAt} IS NOT NULL OR ${table.completedAt} IS NULL)`,
    ),
    check(
      "source_proposals_outcome",
      sql`(${table.outcome} IS NOT NULL) = (${table.status} = 'APPROVED' AND ${table.completedAt} IS NOT NULL)`,
    ),
  ],
);

export const ideas = pgTable(
  "ideas",
  {
    ideaId: uuidColumn("idea_id").primaryKey(),
    vaultId: uuidColumn("vault_id").notNull(),
    documentId: uuidColumn("document_id").notNull(),
    kind: text("kind").notNull(),
    label: text("label").notNull(),
    description: text("description").notNull(),
    embedding: vector("embedding", { dimensions: 1024 }),
    embeddingModel: text("embedding_model"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
  },
  (table) => [
    references(table.vaultId, vaults.id, "ideas_vault_id_fkey", "cascade"),
    references(table.documentId, sourceDocuments.id, "ideas_document_id_fkey", "cascade"),
    index("ix_ideas_vault_id").on(table.vaultId),
    index("ix_ideas_document_id").on(table.documentId),
  ],
);

export const topicProposals = pgTable(
  "topic_proposals",
  {
    id: uuidColumn("id").defaultRandom().primaryKey(),
    vaultId: uuidColumn("vault_id").notNull(),
    documentId: uuidColumn("document_id").notNull(),
    askKey: text("ask_key").notNull(),
    position: integer("position").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    inclusionTest: text("inclusion_test").notNull(),
    ideaIds: uuidColumn("idea_ids").array().notNull(),
    embedding: halfvec("embedding", { dimensions: 1024 }).notNull(),
    paired: boolean("paired").default(false).notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
  },
  (table) => [
    references(table.vaultId, vaults.id, "topic_proposals_vault_id_fkey", "cascade"),
    references(table.documentId, sourceDocuments.id, "topic_proposals_document_id_fkey", "cascade"),
    unique("topic_proposals_document_answer_position_key").on(
      table.documentId,
      table.askKey,
      table.position,
    ),
    index("ix_topic_proposals_vault_id").on(table.vaultId),
  ],
);

export const topicCandidates = pgTable(
  "topic_candidates",
  {
    vaultId: uuidColumn("vault_id").notNull(),
    lowerId: uuidColumn("lower_id").notNull(),
    higherId: uuidColumn("higher_id").notNull(),
    similarity: doublePrecision("similarity").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.lowerId, table.higherId] }),
    references(table.lowerId, topicProposals.id, "topic_candidates_lower_id_fkey", "cascade"),
    references(table.higherId, topicProposals.id, "topic_candidates_higher_id_fkey", "cascade"),
    check("topic_candidates_ordered", sql`${table.lowerId} < ${table.higherId}`),
    index("ix_topic_candidates_vault_id").on(table.vaultId),
    index("ix_topic_candidates_higher_id").on(table.higherId),
  ],
);

export const anchors = pgTable(
  "anchors",
  {
    ideaId: uuidColumn("idea_id").notNull(),
    position: integer("position").notNull(),
    claim: text("claim").notNull(),
    quote: text("quote").notNull(),
    chunkIndex: integer("chunk_index"),
  },
  (table) => [
    references(table.ideaId, ideas.ideaId, "anchors_idea_id_fkey", "cascade"),
    primaryKey({ columns: [table.ideaId, table.position] }),
  ],
);

export const topics = pgTable(
  "topics",
  {
    topicId: uuidColumn("topic_id").primaryKey(),
    vaultId: uuidColumn("vault_id").notNull(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    articleStatus: text("article_status").default("no_article").notNull(),
    compiledFromHash: text("compiled_from_hash"),
    renderedFromHash: text("rendered_from_hash"),
    supersedes: uuidColumn("supersedes"),
    supersededBy: uuidColumn("superseded_by"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at").defaultNow().notNull(),
  },
  (table) => [
    references(table.vaultId, vaults.id, "topics_vault_id_fkey", "cascade"),
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
    topicId: uuidColumn("topic_id").notNull(),
    ideaId: uuidColumn("idea_id").notNull(),
  },
  (table) => [
    references(table.topicId, topics.topicId, "topic_membership_topic_id_fkey", "cascade"),
    references(table.ideaId, ideas.ideaId, "topic_membership_idea_id_fkey", "cascade"),
    primaryKey({ columns: [table.topicId, table.ideaId] }),
  ],
);

export const topicLinks = pgTable(
  "topic_links",
  {
    sourceTopicId: uuidColumn("source_topic_id").notNull(),
    targetTopicId: uuidColumn("target_topic_id").notNull(),
  },
  (table) => [
    references(table.sourceTopicId, topics.topicId, "topic_links_source_topic_id_fkey", "cascade"),
    references(table.targetTopicId, topics.topicId, "topic_links_target_topic_id_fkey", "cascade"),
    primaryKey({ columns: [table.sourceTopicId, table.targetTopicId] }),
  ],
);

export const topicRelated = pgTable(
  "topic_related",
  {
    topicId: uuidColumn("topic_id").notNull(),
    relatedTopicId: uuidColumn("related_topic_id").notNull(),
    sharedDocuments: integer("shared_documents").notNull(),
    jaccard: doublePrecision("jaccard").notNull(),
  },
  (table) => [
    references(table.topicId, topics.topicId, "topic_related_topic_id_fkey", "cascade"),
    references(
      table.relatedTopicId,
      topics.topicId,
      "topic_related_related_topic_id_fkey",
      "cascade",
    ),
    primaryKey({ columns: [table.topicId, table.relatedTopicId] }),
  ],
);

export const wikiArticles = pgTable(
  "wiki_articles",
  {
    id: uuidColumn("id").primaryKey(),
    vaultId: uuidColumn("vault_id").notNull(),
    topicId: uuidColumn("topic_id").notNull(),
    filePath: text("file_path").notNull(),
    fileHash: text("file_hash").notNull(),
    bodyHash: text("body_hash").notNull(),
    title: text("title").notNull(),
    precis: text("precis").notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at").defaultNow().notNull(),
    renderRunId: uuidColumn("render_run_id"),
    addedRunId: uuidColumn("added_run_id"),
    changedRunId: uuidColumn("changed_run_id"),
    archivedRunId: uuidColumn("archived_run_id"),
    archived: boolean("archived").default(false).notNull(),
    tags: text("tags")
      .array()
      .default(sql`ARRAY[]::text[]`)
      .notNull(),
  },
  (table) => [
    references(table.vaultId, vaults.id, "wiki_articles_vault_id_fkey", "cascade"),
    references(table.topicId, topics.topicId, "wiki_articles_topic_id_fkey", "cascade"),
    references(
      table.renderRunId,
      pipelineRuns.id,
      "fk_wiki_articles_render_run_id_pipeline_runs",
      "set null",
    ),
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
    sourceArticleId: uuidColumn("source_article_id").notNull(),
    targetArticleId: uuidColumn("target_article_id").notNull(),
  },
  (table) => [
    references(
      table.sourceArticleId,
      wikiArticles.id,
      "backlinks_source_article_id_fkey",
      "cascade",
    ),
    references(
      table.targetArticleId,
      wikiArticles.id,
      "backlinks_target_article_id_fkey",
      "cascade",
    ),
    primaryKey({ columns: [table.sourceArticleId, table.targetArticleId] }),
  ],
);
