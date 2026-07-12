import { randomUUID } from "node:crypto";
import { posix } from "node:path";

import {
  Database,
  ideas,
  searchIndex,
  sourceDocuments,
  topicMembership,
} from "@great-minds/database";
import { type Uuid } from "@great-minds/domain";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { parse as parseYaml } from "yaml";

import { bodyContentHash, fileContentHash } from "./crypto.ts";
import { dieDatabase } from "./db-defects.ts";
import { VaultStorage } from "./storage.ts";

type SourceDocumentRow = typeof sourceDocuments.$inferSelect;

type SourceDocumentsServiceShape = {
  readonly index: (vaultId: Uuid, filePath: string, content: string) => Effect.Effect<Uuid>;
  readonly batchIndex: (
    vaultId: Uuid,
    documents: readonly {
      readonly filePath: string;
      readonly content: string;
      readonly clientHash: string;
    }[],
  ) => Effect.Effect<void>;
  readonly existingClientHashes: (
    vaultId: Uuid,
    clientHashes: readonly string[],
  ) => Effect.Effect<readonly string[]>;
  readonly getByPath: (
    vaultId: Uuid,
    filePath: string,
  ) => Effect.Effect<SourceDocumentRow | undefined>;
  readonly deleteSource: (
    vaultId: Uuid,
    filePath: string,
    options?: { readonly missingOk?: boolean },
  ) => Effect.Effect<boolean>;
};

export class SourceDocumentsService extends Context.Service<
  SourceDocumentsService,
  SourceDocumentsServiceShape
>()("@great-minds/server/SourceDocumentsService") {}

const FRONTMATTER_RE = /^---\n([\s\S]+?)\n---\n/;

const parseFrontmatter = (content: string) => {
  const match = FRONTMATTER_RE.exec(content);
  if (match === null) {
    return { frontmatter: {}, body: content } as const;
  }
  const yaml = match[1] ?? "";
  const parsed = parseYaml(yaml) as unknown;
  return {
    frontmatter:
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {},
    body: content.slice(match[0].length),
  } as const;
};

const stringField = (frontmatter: Record<string, unknown>, key: string) => {
  const value = frontmatter[key];
  return typeof value === "string" ? value : null;
};

const numberField = (frontmatter: Record<string, unknown>, key: string) => {
  const value = frontmatter[key];
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.length > 0) {
    return Number.parseInt(value, 10);
  }
  return null;
};

const sourceRow = (vaultId: Uuid, filePath: string, content: string, clientHash?: string) => {
  const parsed = parseFrontmatter(content);
  return {
    id: randomUUID(),
    vaultId,
    filePath,
    fileHash: fileContentHash(content),
    bodyHash: bodyContentHash(parsed.body),
    clientHash,
    sourceType: stringField(parsed.frontmatter, "source_type") ?? "document",
    url: stringField(parsed.frontmatter, "url"),
    origin: stringField(parsed.frontmatter, "origin"),
    provenanceSessionId: stringField(parsed.frontmatter, "session_id") as Uuid | null,
    provenanceExchangeId: stringField(parsed.frontmatter, "exchange_id"),
    provenanceSessionQuery: stringField(parsed.frontmatter, "session_query"),
    provenanceSourceDocPath: stringField(parsed.frontmatter, "source_doc_path"),
    provenanceSourceAnchor: stringField(parsed.frontmatter, "source_anchor"),
    provenanceSourceParagraphIndex: numberField(parsed.frontmatter, "source_paragraph_index"),
    provenanceAnchoredTo: stringField(parsed.frontmatter, "anchored_to"),
    provenanceAnchoredSection: stringField(parsed.frontmatter, "anchored_section"),
    provenanceIntent: stringField(parsed.frontmatter, "intent"),
  };
};

const ingestSet = {
  fileHash: sql`excluded.file_hash`,
  bodyHash: sql`excluded.body_hash`,
  clientHash: sql`excluded.client_hash`,
  sourceType: sql`excluded.source_type`,
  etag: sql`excluded.etag`,
  url: sql`excluded.url`,
  origin: sql`excluded.origin`,
  provenanceSessionId: sql`excluded.provenance_session_id`,
  provenanceExchangeId: sql`excluded.provenance_exchange_id`,
  provenanceSessionQuery: sql`excluded.provenance_session_query`,
  provenanceSourceDocPath: sql`excluded.provenance_source_doc_path`,
  provenanceSourceAnchor: sql`excluded.provenance_source_anchor`,
  provenanceSourceParagraphIndex: sql`excluded.provenance_source_paragraph_index`,
  provenanceAnchoredTo: sql`excluded.provenance_anchored_to`,
  provenanceAnchoredSection: sql`excluded.provenance_anchored_section`,
  provenanceIntent: sql`excluded.provenance_intent`,
  updatedAt: sql`now()`,
};

export const safeRawSourcePath = (path: string) => {
  if (path.includes("\\")) {
    return undefined;
  }
  if (path.startsWith("/")) {
    return undefined;
  }
  const rawParts = path.split("/");
  if (rawParts.includes("..")) {
    return undefined;
  }
  const normalized = posix.normalize(path);
  if (normalized === "." || !normalized.endsWith(".md")) {
    return undefined;
  }
  const parts = normalized.split("/");
  if (parts[0] === "raw" && parts.length >= 3) {
    return normalized;
  }
  return undefined;
};

export const SourceDocumentsServiceLive = Layer.effect(
  SourceDocumentsService,
  Effect.gen(function* () {
    const db = yield* Database;
    const storage = yield* VaultStorage;

    return {
      index: (vaultId, filePath, content) =>
        Effect.gen(function* () {
          const rows = yield* db
            .insert(sourceDocuments)
            .values(sourceRow(vaultId, filePath, content))
            .onConflictDoUpdate({
              target: [sourceDocuments.vaultId, sourceDocuments.filePath],
              set: ingestSet,
            })
            .returning({ id: sourceDocuments.id })
            .pipe(dieDatabase);
          const row = rows[0];
          if (row === undefined) {
            throw new Error("source document upsert returned no row");
          }
          return row.id as Uuid;
        }),
      batchIndex: (vaultId, documents) =>
        Effect.gen(function* () {
          if (documents.length === 0) {
            return;
          }
          yield* db
            .insert(sourceDocuments)
            .values(
              documents.map((document) =>
                sourceRow(vaultId, document.filePath, document.content, document.clientHash),
              ),
            )
            .onConflictDoUpdate({
              target: [sourceDocuments.vaultId, sourceDocuments.filePath],
              set: ingestSet,
            })
            .pipe(dieDatabase);
        }),
      existingClientHashes: (vaultId, clientHashes) =>
        Effect.gen(function* () {
          if (clientHashes.length === 0) {
            return [];
          }
          const rows = yield* db
            .select({ clientHash: sourceDocuments.clientHash })
            .from(sourceDocuments)
            .where(
              and(
                eq(sourceDocuments.vaultId, vaultId),
                inArray(sourceDocuments.clientHash, [...clientHashes]),
              ),
            )
            .pipe(dieDatabase);
          return rows
            .map((row) => row.clientHash)
            .filter((hash): hash is string => hash !== null);
        }),
      getByPath: (vaultId, filePath) =>
        Effect.gen(function* () {
          const rows = yield* db
            .select()
            .from(sourceDocuments)
            .where(and(eq(sourceDocuments.vaultId, vaultId), eq(sourceDocuments.filePath, filePath)))
            .limit(1)
            .pipe(dieDatabase);
          return rows[0];
        }),
      deleteSource: (vaultId, filePath, options = {}) =>
        Effect.gen(function* () {
          const deleted = yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const documentRows = yield* tx
                  .select({ id: sourceDocuments.id })
                  .from(sourceDocuments)
                  .where(
                    and(eq(sourceDocuments.vaultId, vaultId), eq(sourceDocuments.filePath, filePath)),
                  )
                  .limit(1);
                const documentId = documentRows[0]?.id;
                if (documentId === undefined) {
                  return false;
                }
                const ideaRows = yield* tx
                  .select({ id: ideas.ideaId })
                  .from(ideas)
                  .where(eq(ideas.documentId, documentId));
                const ideaIds = ideaRows.map((row) => row.id);
                if (ideaIds.length > 0) {
                  yield* tx.delete(topicMembership).where(inArray(topicMembership.ideaId, ideaIds));
                }
                yield* tx
                  .delete(searchIndex)
                  .where(and(eq(searchIndex.vaultId, vaultId), eq(searchIndex.path, filePath)));
                yield* tx.delete(sourceDocuments).where(eq(sourceDocuments.id, documentId));
                return true;
              }),
            )
            .pipe(dieDatabase);
          if (!deleted && options.missingOk !== true) {
            return false;
          }
          yield* storage.deletePath(vaultId, filePath);
          return deleted;
        }),
    } satisfies SourceDocumentsServiceShape;
  }),
);
