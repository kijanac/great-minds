import {
  Database,
  ideas,
  searchIndex,
  sourceDocuments,
  topicMembership,
} from "@great-minds/database";
import { type FileFingerprint, type Uuid } from "@great-minds/domain";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { parse as parseYaml } from "yaml";

import { bodyContentHash, fileContentHash } from "./crypto.ts";
import { sourceIdentityFromFrontmatter } from "./source-identity.ts";
import { ContentStorage, vaultOwner } from "./storage.ts";

type SourceDocumentRow = typeof sourceDocuments.$inferSelect;

type SourceDocumentsServiceShape = {
  readonly index: (
    vaultId: Uuid,
    filePath: string,
    content: string,
    clientHash: FileFingerprint | null,
  ) => Effect.Effect<Uuid>;
  readonly refreshFromStorage: (
    vaultId: Uuid,
    filePath: string,
    content: string,
  ) => Effect.Effect<Uuid>;
  readonly batchIndex: (
    vaultId: Uuid,
    documents: readonly {
      readonly filePath: string;
      readonly content: string;
      readonly clientHash: FileFingerprint;
    }[],
  ) => Effect.Effect<void>;
  readonly existingClientHashes: (
    vaultId: Uuid,
    clientHashes: readonly FileFingerprint[],
  ) => Effect.Effect<readonly FileFingerprint[]>;
  readonly getById: (
    vaultId: Uuid,
    sourceId: Uuid,
  ) => Effect.Effect<SourceDocumentRow | undefined>;
  readonly getByPath: (
    vaultId: Uuid,
    filePath: string,
  ) => Effect.Effect<SourceDocumentRow | undefined>;
  readonly deleteSource: (
    vaultId: Uuid,
    sourceId: Uuid,
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

const documentTitle = (body: string) =>
  /^#\s+(.+?)(?:\s+\^p\d+)?\s*$/m.exec(body)?.[1]?.trim() ?? null;

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

const sourceRow = (
  vaultId: Uuid,
  filePath: string,
  content: string,
  clientHash: FileFingerprint | null,
) => {
  const parsed = parseFrontmatter(content);
  const identity = sourceIdentityFromFrontmatter(parsed.frontmatter);
  return {
    id: identity.sourceId,
    vaultId,
    filePath,
    fileHash: fileContentHash(content),
    bodyHash: bodyContentHash(parsed.body),
    clientHash,
    sourceType: stringField(parsed.frontmatter, "source_type") ?? "document",
    url: stringField(parsed.frontmatter, "url"),
    canonicalUrl: identity.canonicalUrl,
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
    title: documentTitle(parsed.body),
  };
};

const ingestSet = {
  filePath: sql`excluded.file_path`,
  fileHash: sql`excluded.file_hash`,
  bodyHash: sql`excluded.body_hash`,
  clientHash: sql`excluded.client_hash`,
  sourceType: sql`excluded.source_type`,
  etag: sql`excluded.etag`,
  url: sql`excluded.url`,
  canonicalUrl: sql`excluded.canonical_url`,
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
  title: sql`excluded.title`,
  updatedAt: sql`now()`,
};

export const SourceDocumentsServiceLive = Layer.effect(
  SourceDocumentsService,
  Effect.gen(function* () {
    const db = yield* Database;
    const storage = yield* ContentStorage;

    const getById = (vaultId: Uuid, sourceId: Uuid) =>
      db.query((d) => d
        .select()
        .from(sourceDocuments)
        .where(and(eq(sourceDocuments.vaultId, vaultId), eq(sourceDocuments.id, sourceId)))
        .limit(1))
        .pipe(Effect.map((rows) => rows[0]));

    const index = (
      vaultId: Uuid,
      filePath: string,
      content: string,
      clientHash: FileFingerprint | null,
    ) =>
      Effect.gen(function* () {
        const rows = yield* db.query((d) => d
          .insert(sourceDocuments)
          .values(sourceRow(vaultId, filePath, content, clientHash))
          .onConflictDoUpdate({
            target: sourceDocuments.id,
            set: ingestSet,
          })
          .returning({ id: sourceDocuments.id }));
        const row = rows[0];
        if (row === undefined) {
          throw new Error("source document upsert returned no row");
        }
        return row.id as Uuid;
      });

    return {
      index,
      refreshFromStorage: (vaultId, filePath, content) =>
        Effect.gen(function* () {
          const candidate = sourceRow(vaultId, filePath, content, null);
          const registeredPath = yield* db.query((d) => d
            .select({ id: sourceDocuments.id })
            .from(sourceDocuments)
            .where(and(eq(sourceDocuments.vaultId, vaultId), eq(sourceDocuments.filePath, filePath)))
            .limit(1));
          const registeredId = registeredPath[0]?.id;
          if (registeredId !== undefined && registeredId !== candidate.id) {
            throw new Error(
              `Source identity mismatch at ${filePath}: registered ${registeredId}, stored ${candidate.id}`,
            );
          }
          const existing = yield* getById(vaultId, candidate.id as Uuid);
          const clientHash = existing?.clientHash ?? null;
          return yield* index(vaultId, filePath, content, clientHash as FileFingerprint | null);
        }),
      batchIndex: (vaultId, documents) =>
        Effect.gen(function* () {
          if (documents.length === 0) return;
          yield* db.query((d) => d
            .insert(sourceDocuments)
            .values(
              documents.map((document) =>
                sourceRow(vaultId, document.filePath, document.content, document.clientHash),
              ),
            )
            .onConflictDoUpdate({
              target: sourceDocuments.id,
              set: ingestSet,
            }));
        }),
      existingClientHashes: (vaultId, clientHashes) =>
        Effect.gen(function* () {
          if (clientHashes.length === 0) return [];
          const rows = yield* db.query((d) => d
            .select({ clientHash: sourceDocuments.clientHash })
            .from(sourceDocuments)
            .where(
              and(
                eq(sourceDocuments.vaultId, vaultId),
                inArray(sourceDocuments.clientHash, [...clientHashes]),
              ),
            ));
          return rows
            .map((row) => row.clientHash)
            .filter((hash): hash is string => hash !== null)
            .map((hash) => hash as FileFingerprint);
        }),
      getById,
      getByPath: (vaultId, filePath) =>
        db.query((d) => d
          .select()
          .from(sourceDocuments)
          .where(and(eq(sourceDocuments.vaultId, vaultId), eq(sourceDocuments.filePath, filePath)))
          .limit(1))
          .pipe(Effect.map((rows) => rows[0])),
      deleteSource: (vaultId, sourceId) =>
        Effect.gen(function* () {
          const filePath = yield* db.transaction((tx) =>
            Effect.gen(function* () {
              const source = yield* tx
                .select({ filePath: sourceDocuments.filePath })
                .from(sourceDocuments)
                .where(and(eq(sourceDocuments.vaultId, vaultId), eq(sourceDocuments.id, sourceId)))
                .limit(1);
              const path = source[0]?.filePath;
              if (path === undefined) return null;
              const ideaRows = yield* tx
                .select({ id: ideas.ideaId })
                .from(ideas)
                .where(eq(ideas.documentId, sourceId));
              const ideaIds = ideaRows.map((row) => row.id);
              if (ideaIds.length > 0) {
                yield* tx.delete(topicMembership).where(inArray(topicMembership.ideaId, ideaIds));
              }
              yield* tx
                .delete(searchIndex)
                .where(and(eq(searchIndex.vaultId, vaultId), eq(searchIndex.path, path)));
              yield* tx.delete(sourceDocuments).where(eq(sourceDocuments.id, sourceId));
              return path;
            }),
          );
          if (filePath === null) return false;
          yield* storage.deletePath(vaultOwner(vaultId), filePath);
          return true;
        }),
    } satisfies SourceDocumentsServiceShape;
  }),
);
