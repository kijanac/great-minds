import { posix } from "node:path";

import {
  backlinks,
  Database,
  searchIndex,
  sourceDocuments,
  topicRelated,
  topics,
  wikiArticles,
} from "@great-minds/database";
import {
  BadRequest,
  Forbidden,
  NotFound,
  type Chunk,
  type ChunkRangeQuery,
  type DocResponse,
  type LinkedArticles,
  type LinkQuery,
  type SourceDocument,
  type Uuid,
  type WikiArticle,
  type WikiArticleOverview,
} from "@great-minds/domain";
import { alias } from "drizzle-orm/pg-core";
import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { ContentStorage, vaultOwner } from "./storage.ts";
import { VaultAccessService } from "./vaults.ts";

const MAX_CHUNK_SPAN = 100;

export class DocumentRegistryMismatch extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`Document on disk lacks a registry row: ${path}`);
    this.name = "DocumentRegistryMismatch";
    this.path = path;
  }
}

type DocumentsServiceShape = {
  readonly readDocument: (
    userId: Uuid,
    vaultId: Uuid,
    path: string,
  ) => Effect.Effect<DocResponse, BadRequest | Forbidden | NotFound>;
  readonly readSource: (
    userId: Uuid,
    vaultId: Uuid,
    sourceId: Uuid,
  ) => Effect.Effect<DocResponse, Forbidden | NotFound>;
  readonly readChunks: (
    userId: Uuid,
    vaultId: Uuid,
    query: ChunkRangeQuery,
  ) => Effect.Effect<readonly Chunk[], Forbidden>;
  readonly readLinks: (
    userId: Uuid,
    vaultId: Uuid,
    query: LinkQuery,
  ) => Effect.Effect<LinkedArticles, Forbidden | NotFound>;
};

export class DocumentsService extends Context.Service<DocumentsService, DocumentsServiceShape>()(
  "@great-minds/server/DocumentsService",
) {}

const DerivedExtras = Schema.Record(Schema.String, Schema.Unknown);
const decodeDerivedExtras = Schema.decodeUnknownSync(DerivedExtras);

const dateIso = (value: Date | null) => value?.toISOString() ?? null;

const wikiSlug = (filePath: string) => filePath.replace(/^wiki\//, "").replace(/\.md$/, "");

const wikiArticle = (row: typeof wikiArticles.$inferSelect): WikiArticle => ({
  kind: "wiki",
  id: row.id as Uuid,
  vault_id: row.vaultId as Uuid,
  topic_id: row.topicId as Uuid,
  file_path: row.filePath,
  body_hash: row.bodyHash,
  title: row.title,
  precis: row.precis,
  tags: row.tags,
  created_at: dateIso(row.createdAt),
  updated_at: dateIso(row.updatedAt),
  slug: wikiSlug(row.filePath),
});

const sourceDocument = (row: typeof sourceDocuments.$inferSelect): SourceDocument => ({
  kind: "source",
  id: row.id as Uuid,
  vault_id: row.vaultId as Uuid,
  file_path: row.filePath,
  body_hash: row.bodyHash,
  source_type: row.sourceType,
  etag: row.etag,
  url: row.url,
  canonical_url: row.canonicalUrl,
  origin: row.origin,
  provenance_session_id: row.provenanceSessionId as Uuid | null,
  provenance_exchange_id: row.provenanceExchangeId,
  provenance_session_query: row.provenanceSessionQuery,
  provenance_source_doc_path: row.provenanceSourceDocPath,
  provenance_source_anchor: row.provenanceSourceAnchor,
  provenance_source_paragraph_index: row.provenanceSourceParagraphIndex,
  provenance_anchored_to: row.provenanceAnchoredTo,
  provenance_anchored_section: row.provenanceAnchoredSection,
  provenance_intent: row.provenanceIntent,
  title: row.title,
  precis: row.precis,
  author: row.author,
  published_date: row.publishedDate,
  genre: row.genre,
  tags: row.tags,
  derived_extras: decodeDerivedExtras(row.derivedExtras),
  created_at: dateIso(row.createdAt),
  updated_at: dateIso(row.updatedAt),
});

const wikiOverview = (row: {
  readonly filePath: string;
  readonly title: string;
  readonly precis: string;
  readonly updatedAt: Date | null;
}): WikiArticleOverview => ({
  file_path: row.filePath,
  title: row.title,
  precis: row.precis,
  updated_at: dateIso(row.updatedAt),
  slug: wikiSlug(row.filePath),
});

const stripFrontmatter = (content: string) => {
  const match = /^---\n(.+?)\n---\n/s.exec(content);
  return match === null ? content : content.slice(match[0].length);
};

const safeDocumentReadPath = (path: string) => {
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
  if (parts[0] === "wiki" && parts.length >= 2) {
    return normalized;
  }
  if (parts[0] === "raw" && parts.length >= 3) {
    return normalized;
  }
  return undefined;
};

const first = <A>(rows: readonly A[]) => rows[0];

export const DocumentsServiceLive = Layer.effect(
  DocumentsService,
  Effect.gen(function* () {
    const db = yield* Database;
    const access = yield* VaultAccessService;
    const storage = yield* ContentStorage;

    const getWikiByPath = (vaultId: Uuid, filePath: string) =>
      Effect.gen(function* () {
        const rows = yield* db.query((d) => d
          .select()
          .from(wikiArticles)
          .where(and(eq(wikiArticles.vaultId, vaultId), eq(wikiArticles.filePath, filePath)))
          .limit(1));
        const row = first(rows);
        return row === undefined ? undefined : wikiArticle(row);
      });

    const getWikiByTopic = (vaultId: Uuid, topicId: Uuid) =>
      Effect.gen(function* () {
        const rows = yield* db.query((d) => d
          .select()
          .from(wikiArticles)
          .where(and(eq(wikiArticles.vaultId, vaultId), eq(wikiArticles.topicId, topicId)))
          .limit(1));
        const row = first(rows);
        return row === undefined ? undefined : wikiArticle(row);
      });

    const getSourceByPath = (vaultId: Uuid, filePath: string) =>
      Effect.gen(function* () {
        const rows = yield* db.query((d) => d
          .select()
          .from(sourceDocuments)
          .where(and(eq(sourceDocuments.vaultId, vaultId), eq(sourceDocuments.filePath, filePath)))
          .limit(1));
        const row = first(rows);
        return row === undefined ? undefined : sourceDocument(row);
      });

    const getSourceById = (vaultId: Uuid, sourceId: Uuid) =>
      Effect.gen(function* () {
        const rows = yield* db.query((d) => d
          .select()
          .from(sourceDocuments)
          .where(and(eq(sourceDocuments.vaultId, vaultId), eq(sourceDocuments.id, sourceId)))
          .limit(1));
        const row = first(rows);
        return row === undefined ? undefined : sourceDocument(row);
      });

    const readArchivedWiki = (vaultId: Uuid, filePath: string) =>
      Effect.gen(function* () {
        const slug = wikiSlug(filePath.slice(filePath.lastIndexOf("/") + 1));
        const topicRows = yield* db.query((d) => d
          .select()
          .from(topics)
          .where(and(eq(topics.vaultId, vaultId), eq(topics.slug, slug)))
          .limit(1));
        const topic = first(topicRows);
        if (topic === undefined || topic.articleStatus !== "archived") {
          return undefined;
        }
        const article = yield* getWikiByTopic(vaultId, topic.topicId as Uuid);
        if (article === undefined) {
          return undefined;
        }
        const archivedContent = yield* Effect.result(
          storage.readText(vaultOwner(vaultId), article.file_path),
        );
        if (archivedContent._tag === "Failure") {
          return undefined;
        }
        let successorSlug: string | null = null;
        if (topic.supersededBy !== null) {
          const successorId = topic.supersededBy;
          const successorRows = yield* db.query((d) => d
            .select({ slug: topics.slug })
            .from(topics)
            .where(eq(topics.topicId, successorId))
            .limit(1));
          successorSlug = first(successorRows)?.slug ?? null;
        }
        return {
          article,
          body: stripFrontmatter(archivedContent.success),
          archived: true,
          superseded_by: successorSlug,
        } satisfies DocResponse;
      });

    const readDocument = (userId: Uuid, vaultId: Uuid, path: string) =>
      Effect.gen(function* () {
        yield* access.requireMember(userId, vaultId);
        const safePath = safeDocumentReadPath(path);
        if (safePath === undefined) {
          return yield* new BadRequest({ detail: `Invalid document path: ${path}` });
        }

        const content = yield* Effect.result(storage.readText(vaultOwner(vaultId), safePath));
        if (content._tag === "Failure") {
          if (safePath.startsWith("wiki/")) {
            const archived = yield* readArchivedWiki(vaultId, safePath);
            if (archived !== undefined) {
              return archived;
            }
          }
          return yield* new NotFound({ detail: `Document not found: ${safePath}` });
        }

        const body = stripFrontmatter(content.success);
        if (safePath.startsWith("wiki/")) {
          const article = yield* getWikiByPath(vaultId, safePath);
          if (article !== undefined) {
            return {
              article,
              body,
              archived: false,
              superseded_by: null,
            } satisfies DocResponse;
          }
        } else {
          const article = yield* getSourceByPath(vaultId, safePath);
          if (article !== undefined) {
            return {
              article,
              body,
              archived: false,
              superseded_by: null,
            } satisfies DocResponse;
          }
        }

        throw new DocumentRegistryMismatch(safePath);
      });

    const readSource = (userId: Uuid, vaultId: Uuid, sourceId: Uuid) =>
      Effect.gen(function* () {
        yield* access.requireMember(userId, vaultId);
        const article = yield* getSourceById(vaultId, sourceId);
        if (article === undefined) {
          return yield* new NotFound({ detail: "Source not found" });
        }
        const content = yield* Effect.result(
          storage.readText(vaultOwner(vaultId), article.file_path),
        );
        if (content._tag === "Failure") {
          return yield* new NotFound({ detail: "Source content not found" });
        }
        return {
          article,
          body: stripFrontmatter(content.success),
          archived: false,
          superseded_by: null,
        } satisfies DocResponse;
      });

    const readChunks = (userId: Uuid, vaultId: Uuid, query: ChunkRangeQuery) =>
      Effect.gen(function* () {
        yield* access.requireMember(userId, vaultId);
        const end = Math.min(query.end, query.start + MAX_CHUNK_SPAN - 1);
        const rows = yield* db.query((d) => d
          .select({
            path: searchIndex.path,
            chunkIndex: searchIndex.chunkIndex,
            heading: searchIndex.heading,
            body: searchIndex.body,
            contentHash: searchIndex.contentHash,
          })
          .from(searchIndex)
          .where(
            and(
              eq(searchIndex.vaultId, vaultId),
              eq(searchIndex.path, query.path),
              gte(searchIndex.chunkIndex, Math.max(0, query.start)),
              lte(searchIndex.chunkIndex, end),
            ),
          )
          .orderBy(asc(searchIndex.chunkIndex)));
        return rows.map((row) => ({
          path: row.path,
          chunk_index: row.chunkIndex,
          heading: row.heading,
          body: row.body,
          content_hash: row.contentHash,
        }));
      });

    const readLinks = (userId: Uuid, vaultId: Uuid, query: LinkQuery) =>
      Effect.gen(function* () {
        yield* access.requireMember(userId, vaultId);
        const sourceArticle = yield* db.query((d) => d
          .select({ id: wikiArticles.id, topicId: wikiArticles.topicId })
          .from(wikiArticles)
          .where(
            and(
              eq(wikiArticles.vaultId, vaultId),
              eq(wikiArticles.filePath, query.path),
              eq(wikiArticles.archived, false),
            ),
          )
          .limit(1));
        const source = first(sourceArticle);
        if (source === undefined) {
          return yield* new NotFound({ detail: `Not a wiki article: ${query.path}` });
        }

        const outgoingArticle = alias(wikiArticles, "outgoing_article");
        const incomingArticle = alias(wikiArticles, "incoming_article");
        const outgoing = yield* db.query((d) => d
          .select({
            filePath: outgoingArticle.filePath,
            title: outgoingArticle.title,
            precis: outgoingArticle.precis,
            updatedAt: outgoingArticle.updatedAt,
          })
          .from(backlinks)
          .innerJoin(outgoingArticle, eq(outgoingArticle.id, backlinks.targetArticleId))
          .where(
            and(
              eq(backlinks.sourceArticleId, source.id),
              eq(outgoingArticle.vaultId, vaultId),
              eq(outgoingArticle.archived, false),
            ),
          )
          .orderBy(asc(sql`lower(${outgoingArticle.title})`)));
        const incoming = yield* db.query((d) => d
          .select({
            filePath: incomingArticle.filePath,
            title: incomingArticle.title,
            precis: incomingArticle.precis,
            updatedAt: incomingArticle.updatedAt,
          })
          .from(backlinks)
          .innerJoin(incomingArticle, eq(incomingArticle.id, backlinks.sourceArticleId))
          .where(
            and(
              eq(backlinks.targetArticleId, source.id),
              eq(incomingArticle.vaultId, vaultId),
              eq(incomingArticle.archived, false),
            ),
          )
          .orderBy(asc(sql`lower(${incomingArticle.title})`)));

        // Idea-overlap relatedness from the derive phase; require at least two
        // shared ideas so a single incidental overlap never surfaces.
        const relatedArticle = alias(wikiArticles, "related_article");
        const related = yield* db.query((d) => d
          .select({
            filePath: relatedArticle.filePath,
            title: relatedArticle.title,
            precis: relatedArticle.precis,
            updatedAt: relatedArticle.updatedAt,
          })
          .from(topicRelated)
          .innerJoin(relatedArticle, eq(relatedArticle.topicId, topicRelated.relatedTopicId))
          .where(
            and(
              eq(topicRelated.topicId, source.topicId),
              gte(topicRelated.sharedIdeas, 2),
              eq(relatedArticle.vaultId, vaultId),
              eq(relatedArticle.archived, false),
            ),
          )
          .orderBy(desc(topicRelated.jaccard), asc(sql`lower(${relatedArticle.title})`))
          .limit(5));

        return {
          outgoing: outgoing.map(wikiOverview),
          incoming: incoming.map(wikiOverview),
          related: related.map(wikiOverview),
        } satisfies LinkedArticles;
      });

    return {
      readDocument,
      readSource,
      readChunks,
      readLinks,
    } satisfies DocumentsServiceShape;
  }),
);
