import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
  vector
} from "drizzle-orm/pg-core";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

export const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return "tsvector";
  }
});

export const memberRole = pgEnum("member_role", ["OWNER", "EDITOR", "VIEWER"]);

export const authCodes = pgTable(
  "auth_codes",
  {
    id: uuid("id").primaryKey(),
    email: varchar("email", { length: 320 }).notNull(),
    codeHash: varchar("code_hash", { length: 64 }).notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    used: boolean("used").notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull()
  },
  (table) => [index("ix_auth_codes_email").on(table.email)]
);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey(),
    email: varchar("email", { length: 320 }).notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    r2BucketName: text("r2_bucket_name")
  },
  (table) => [uniqueIndex("ix_users_email").on(table.email)]
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    keyHash: varchar("key_hash", { length: 64 }).notNull(),
    label: text("label").notNull(),
    revoked: boolean("revoked").notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull()
  },
  (table) => [uniqueIndex("ix_api_keys_key_hash").on(table.keyHash)]
);

export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    revoked: boolean("revoked").notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull()
  },
  (table) => [uniqueIndex("ix_refresh_tokens_token_hash").on(table.tokenHash)]
);

export const vaults = pgTable(
  "vaults",
  {
    id: uuid("id").primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    r2BucketName: text("r2_bucket_name")
  }
);

export const vaultMemberships = pgTable(
  "vault_memberships",
  {
    id: uuid("id").primaryKey(),
    vaultId: uuid("vault_id")
      .notNull()
      .references(() => vaults.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: memberRole("role").notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull()
  },
  (table) => [unique("vault_memberships_vault_id_user_id_key").on(table.vaultId, table.userId)]
);

export const pipelineRuns = pgTable(
  "pipeline_runs",
  {
    id: uuid("id").primaryKey(),
    vaultId: uuid("vault_id")
      .notNull()
      .references(() => vaults.id, { onDelete: "cascade" }),
    trigger: text("trigger").notNull(),
    status: text("status").notNull(),
    currentPhase: text("current_phase").notNull(),
    phaseStatus: text("phase_status").notNull(),
    progressSteps: jsonb("progress_steps").default(sql`'[]'::jsonb`).notNull(),
    error: text("error"),
    ingestTaskId: uuid("ingest_task_id"),
    compileIntentId: uuid("compile_intent_id"),
    compileTaskId: uuid("compile_task_id"),
    activeTaskId: uuid("active_task_id"),
    activeTaskType: text("active_task_type"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at").defaultNow().notNull(),
    completedAt: timestamptz("completed_at")
  },
  (table) => [index("ix_pipeline_runs_vault_id").on(table.vaultId)]
);

export const searchIndex = pgTable(
  "search_index",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    vaultId: uuid("vault_id")
      .notNull()
      .references(() => vaults.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    heading: text("heading").notNull(),
    body: text("body").notNull(),
    contentHash: text("content_hash").notNull(),
    tsv: tsvector("tsv").notNull(),
    embedding: vector("embedding", { dimensions: 1024 }),
    updatedAt: timestamptz("updated_at").defaultNow().notNull()
  },
  (table) => [
    unique("search_index_vault_id_path_chunk_index_key").on(
      table.vaultId,
      table.path,
      table.chunkIndex
    ),
    index("ix_search_index_vault_id").on(table.vaultId),
    index("ix_search_index_tsv").using("gin", table.tsv),
    index("ix_search_index_embedding").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops")
    )
  ]
);

export const topics = pgTable(
  "topics",
  {
    topicId: uuid("topic_id").primaryKey(),
    vaultId: uuid("vault_id")
      .notNull()
      .references(() => vaults.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    articleStatus: text("article_status").default("no_article").notNull(),
    compiledFromHash: text("compiled_from_hash"),
    renderedFromHash: text("rendered_from_hash"),
    supersedes: uuid("supersedes"),
    supersededBy: uuid("superseded_by"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at").defaultNow().notNull()
  },
  (table) => [
    index("ix_topics_vault_id").on(table.vaultId),
    unique("topics_vault_id_slug_key").on(table.vaultId, table.slug)
  ]
);

export const wikiArticles = pgTable(
  "wiki_articles",
  {
    id: uuid("id").primaryKey(),
    vaultId: uuid("vault_id")
      .notNull()
      .references(() => vaults.id, { onDelete: "cascade" }),
    topicId: uuid("topic_id")
      .notNull()
      .references(() => topics.topicId, { onDelete: "cascade" }),
    filePath: text("file_path").notNull(),
    fileHash: text("file_hash").notNull(),
    bodyHash: text("body_hash").notNull(),
    title: text("title").notNull(),
    precis: text("precis").notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at").defaultNow().notNull(),
    renderRunId: uuid("render_run_id").references(() => pipelineRuns.id, {
      onDelete: "set null"
    }),
    archived: boolean("archived").default(false).notNull(),
    tags: text("tags").array().default(sql`ARRAY[]::text[]`).notNull()
  },
  (table) => [
    unique("wiki_articles_topic_id_key").on(table.topicId),
    index("ix_wiki_articles_vault_id").on(table.vaultId),
    index("ix_wiki_articles_render_run_id")
      .on(table.renderRunId)
      .where(sql`${table.renderRunId} IS NOT NULL`)
  ]
);

export const schema = {
  authCodes,
  apiKeys,
  refreshTokens,
  users,
  vaults,
  vaultMemberships,
  pipelineRuns,
  searchIndex,
  topics,
  wikiArticles
};
