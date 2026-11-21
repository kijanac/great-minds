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
  type Uuid,
  type WikiArticle,
} from "@great-minds/domain";
import { alias } from "drizzle-orm/pg-core";
import { and, asc, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";

import { stripFrontmatter } from "./markdown.ts";
import { ContentStorage, vaultOwner } from "./storage.ts";
import { withFootnoteNotes } from "./wiki-footnotes.ts";
import { sourceDocument, wikiOverview, wikiSlug } from "./document-metadata.ts";
import { VaultAccessService } from "./vaults.ts";

const MAX_CHUNK_SPAN = 100;

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

const wikiArticle = (row: typeof wikiArticles.$inferSelect): WikiArticle => ({
  kind: "wiki",
  id: row.id,
  vault_id: row.vaultId,
  topic_id: row.topicId,
  file_path: row.filePath,
  body_hash: row.bodyHash,
  title: row.title,
  precis: row.precis,
  tags: row.tags,
  created_at: row.createdAt,
  updated_at: row.updatedAt,
  slug: wikiSlug(row.filePath),
});

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

export const chunkRange = (
  db: Database["Service"],
  storage: ContentStorage["Service"],
  vaultId: Uuid,
  path: string,
  start: number,
  end: number,
) =>
  Effect.gen(function* () {
    const rows = yield* db.query((d) =>
      d
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
            eq(searchIndex.path, path),
            gte(searchIndex.chunkIndex, start),
            lte(searchIndex.chunkIndex, end),
          ),
        )
        .orderBy(asc(searchIndex.chunkIndex)),
    );
    return yield* withFootnoteNotes(storage, vaultId, rows);
  });

export const articleLinks = (db: Database["Service"], vaultId: Uuid, path: string) =>
  Effect.gen(function* () {
    const sourceArticle = yield* db.query((d) =>
      d
        .select({ id: wikiArticles.id, topicId: wikiArticles.topicId })
        .from(wikiArticles)
        .where(
          and(
            eq(wikiArticles.vaultId, vaultId),
            eq(wikiArticles.filePath, path),
            eq(wikiArticles.archived, false),
          ),
        )
        .limit(1),
    );
    const source = first(sourceArticle);
    if (source === undefined) return undefined;

    const outgoingArticle = alias(wikiArticles, "outgoing_article");
    const incomingArticle = alias(wikiArticles, "incoming_article");
    const outgoing = yield* db.query((d) =>
      d
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
        .orderBy(asc(sql`lower(${outgoingArticle.title})`)),
    );
    const incoming = yield* db.query((d) =>
      d
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
        .orderBy(asc(sql`lower(${incomingArticle.title})`)),
    );

    const relatedArticle = alias(wikiArticles, "related_article");
    const related = yield* db.query((d) =>
      d
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
            gte(topicRelated.sharedDocuments, 2),
            eq(relatedArticle.vaultId, vaultId),
            eq(relatedArticle.archived, false),
          ),
        )
        .orderBy(desc(topicRelated.jaccard), asc(sql`lower(${relatedArticle.title})`))
        .limit(5),
    );

    return {
      outgoing: outgoing.map(wikiOverview),
      incoming: incoming.map(wikiOverview),
      related: related.map(wikiOverview),
    } satisfies LinkedArticles;
  });

export const DocumentsServiceLive = Layer.effect(
  DocumentsService,
  Effect.gen(function* () {
    const db = yield* Database;
    const access = yield* VaultAccessService;
    const storage = yield* ContentStorage;

    const findWiki = (vaultId: Uuid, match: SQL) =>
      db
        .query((d) =>
          d
            .select()
            .from(wikiArticles)
            .where(and(eq(wikiArticles.vaultId, vaultId), match))
            .limit(1),
        )
        .pipe(
          Effect.map((rows) => {
            const row = first(rows);
            return row === undefined ? undefined : wikiArticle(row);
          }),
        );

    const findSource = (vaultId: Uuid, match: SQL) =>
      Effect.gen(function* () {
        const rows = yield* db.query((d) =>
          d
            .select()
            .from(sourceDocuments)
            .where(and(eq(sourceDocuments.vaultId, vaultId), match))
            .limit(1),
        );
        const row = first(rows);
        return row === undefined ? undefined : sourceDocument(row);
      });

    const readArchivedWiki = (vaultId: Uuid, filePath: string) =>
      Effect.gen(function* () {
        const slug = wikiSlug(filePath.slice(filePath.lastIndexOf("/") + 1));
        const topicRows = yield* db.query((d) =>
          d
            .select()
            .from(topics)
            .where(and(eq(topics.vaultId, vaultId), eq(topics.slug, slug)))
            .limit(1),
        );
        const topic = first(topicRows);
        if (topic === undefined || topic.articleStatus !== "archived") {
          return undefined;
        }
        const article = yield* findWiki(vaultId, eq(wikiArticles.topicId, topic.topicId));
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
        const followed = new Set([topic.topicId]);
        let successorId = topic.supersededBy;
        while (successorId !== null && !followed.has(successorId)) {
          const id = successorId;
          followed.add(id);
          const successor = first(
            yield* db.query((d) =>
              d
                .select({
                  slug: topics.slug,
                  status: topics.articleStatus,
                  supersededBy: topics.supersededBy,
                })
                .from(topics)
                .where(eq(topics.topicId, id))
                .limit(1),
            ),
          );
          if (successor === undefined) break;
          successorSlug = successor.slug;
          successorId = successor.status === "archived" ? successor.supersededBy : null;
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
          const article = yield* findWiki(vaultId, eq(wikiArticles.filePath, safePath));
          if (article !== undefined) {
            return {
              article,
              body,
              archived: false,
              superseded_by: null,
            } satisfies DocResponse;
          }
        } else {
          const article = yield* findSource(vaultId, eq(sourceDocuments.filePath, safePath));
          if (article !== undefined) {
            return {
              article,
              body,
              archived: false,
              superseded_by: null,
            } satisfies DocResponse;
          }
        }

        return yield* new NotFound({ detail: `Document not found: ${safePath}` });
      });

    const readSource = (userId: Uuid, vaultId: Uuid, sourceId: Uuid) =>
      Effect.gen(function* () {
        yield* access.requireMember(userId, vaultId);
        const article = yield* findSource(vaultId, eq(sourceDocuments.id, sourceId));
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
        const rows = yield* chunkRange(
          db,
          storage,
          vaultId,
          query.path,
          Math.max(0, query.start),
          Math.min(query.end, query.start + MAX_CHUNK_SPAN - 1),
        );
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
        const links = yield* articleLinks(db, vaultId, query.path);
        if (links === undefined)
          return yield* new NotFound({ detail: `Not a wiki article: ${query.path}` });
        return links;
      });

    return {
      readDocument,
      readSource,
      readChunks,
      readLinks,
    } satisfies DocumentsServiceShape;
  }),
);
