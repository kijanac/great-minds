import {
  backlinks,
  Database,
  ideas,
  inUuidArray,
  type DatabaseInfraError,
  type TransactionClient,
  searchIndex,
  sourceDocuments,
  topicMembership,
  topicRelated,
  topics,
  uuidPairs,
  wikiArticles,
} from "@great-minds/database";
import { Uuid } from "@great-minds/domain";
import { and, asc, eq, inArray, like, notInArray, sql } from "drizzle-orm";
import type { PgInsertValue } from "drizzle-orm/pg-core";
import { Context, Effect, Layer } from "effect";

import { ClockService } from "./clock.ts";
import {
  DERIVE_STEP_LABELS,
  INGEST_STEP_LABELS,
  PUBLISH_STEP_LABELS,
  topicContentHash,
  VERIFY_STEP_LABELS,
  type ArchiveTransition,
  type ValidatedTopic,
} from "./compile-contract.ts";
import { makeCompileExtract } from "./compile-extract.ts";
import { makeThemesPipeline } from "./compile-themes-pipeline.ts";
import { AppConfig } from "./config.ts";
import { bodyContentHash, contentHash, fileContentHash } from "./crypto.ts";
import { EmbeddingsService, isTimeoutError, vectorLiteral } from "./embeddings.ts";
import { errorDetails } from "./error-details.ts";
import { LanguageModel } from "./llm.ts";
import { StructuredLogger } from "./logging.ts";
import {
  markdownParagraphs,
  openingSentence,
  parseFrontmatter,
  withoutFootnoteDefinitions,
  serializeFrontmatter,
} from "./markdown.ts";
import { PipelineRunsService, progressSteps } from "./pipeline-runs.ts";
import { SourceDocumentsService } from "./source-documents.ts";
import { liveArticleConditions } from "./wiki-articles.ts";
import { ContentStorage, READ_CONCURRENCY, vaultOwner } from "./storage.ts";
import { append } from "./collections.ts";
import { RandomBytesService } from "./random.ts";

const SEARCH_WRITE_BATCH = 200;
const START_HERE = 8;

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const metadataText = (frontmatter: Record<string, unknown>) => {
  const parts: string[] = [];
  const title = frontmatter.title;
  if (title) parts.push(String(title));
  const precis = frontmatter.precis || frontmatter.description;
  if (precis) parts.push(String(precis));
  const author = frontmatter.author;
  if (author) parts.push(`by ${String(author)}`);
  return parts.length === 0 ? undefined : parts.join("\n\n");
};

type SearchDocument =
  | {
      readonly kind: "source";
      readonly path: string;
      readonly etag: string | null;
      readonly source: typeof sourceDocuments.$inferSelect;
    }
  | { readonly kind: "wiki"; readonly path: string; readonly etag: string | null };

type SearchChunk = {
  readonly chunkIndex: number;
  readonly heading: string;
  readonly body: string;
  readonly contentHash: string;
};

const chunkDocument = (
  parsed: ReturnType<typeof parseFrontmatter>,
  kind: SearchDocument["kind"],
): readonly SearchChunk[] => {
  const result: SearchChunk[] = [];
  const metadata = metadataText(parsed.frontmatter);
  if (metadata !== undefined) {
    result.push({
      chunkIndex: -1,
      heading: "",
      body: metadata,
      contentHash: contentHash("chunk", metadata),
    });
  }
  const body = kind === "wiki" ? withoutFootnoteDefinitions(parsed.body) : parsed.body;
  for (const paragraph of markdownParagraphs(body)) {
    const body =
      paragraph.heading.length === 0 ? paragraph.body : `${paragraph.heading}\n\n${paragraph.body}`;
    result.push({
      chunkIndex: paragraph.index,
      heading: paragraph.heading,
      body,
      contentHash: contentHash("chunk", body),
    });
  }
  return result;
};

type CompilePhasesShape = {
  readonly archiveTransitions: (
    vaultId: Uuid,
    runId: Uuid,
    transitions: readonly ArchiveTransition[],
  ) => Effect.Effect<void, unknown>;
  readonly ingest: (vaultId: Uuid, runId: Uuid) => Effect.Effect<void, unknown>;
  readonly extract: (vaultId: Uuid, runId: Uuid) => Effect.Effect<void, unknown>;
  readonly abstract: (
    vaultId: Uuid,
    runId: Uuid,
  ) => Effect.Effect<readonly ValidatedTopic[], unknown>;
  readonly derive: (
    vaultId: Uuid,
    runId: Uuid,
    validated: readonly ValidatedTopic[],
  ) => Effect.Effect<void, unknown>;
  readonly render: (
    vaultId: Uuid,
    runId: Uuid,
    validated: readonly ValidatedTopic[],
  ) => Effect.Effect<void, unknown>;
  readonly verify: (vaultId: Uuid, runId: Uuid) => Effect.Effect<void, unknown>;
  readonly publish: (vaultId: Uuid, runId: Uuid) => Effect.Effect<void, unknown>;
};

export class CompilePhases extends Context.Service<CompilePhases, CompilePhasesShape>()(
  "@great-minds/server/CompilePhases",
) {}

export const CompilePhasesLive = Layer.effect(
  CompilePhases,
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const db = yield* Database;
    const embeddings = yield* EmbeddingsService;
    const languageModel = yield* LanguageModel;
    const logger = yield* StructuredLogger;
    const pipeline = yield* PipelineRunsService;
    const randomBytes = yield* RandomBytesService;
    const clock = yield* ClockService;
    const storage = yield* ContentStorage;
    const sourceRegistry = yield* SourceDocumentsService;

    const rebuildSearchScope = (vaultId: Uuid, runId: Uuid, scope: "raw" | "wiki") =>
      Effect.gen(function* () {
        const prefix = `${scope}/`;
        const files: SearchDocument[] =
          scope === "raw"
            ? (yield* sourceRegistry.discover(vaultId)).map((document) => ({
                kind: "source",
                path: document.source.filePath,
                ...document,
              }))
            : (yield* storage.listMarkdown(vaultOwner(vaultId), "wiki"))
                .filter((file) => !file.path.slice(file.path.lastIndexOf("/") + 1).startsWith("_"))
                .map((file) => ({ kind: "wiki", ...file }));
        const project = (
          document: SearchDocument,
          mutate: (tx: TransactionClient) => Effect.Effect<void, DatabaseInfraError>,
        ) =>
          document.kind === "source"
            ? sourceRegistry.withCurrent(document.source, mutate)
            : db.transaction((tx) => mutate(tx).pipe(Effect.as(true)));
        const reportProgress = (done: number) =>
          scope === "raw"
            ? pipeline.updateProgress(
                runId,
                "ingest",
                "progress",
                progressSteps(INGEST_STEP_LABELS, "index_sources", {
                  counts: { index_sources: [done, files.length] },
                }),
              )
            : Effect.void;
        yield* reportProgress(0);

        const indexedPaths: string[] = [];
        const timedOut: string[] = [];
        let indexedChunks = 0;
        for (let start = 0; start < files.length; start += 100) {
          const batch = files.slice(start, start + 100);
          const indexed = yield* db.query((d) =>
            d
              .select({
                path: searchIndex.path,
                chunkIndex: searchIndex.chunkIndex,
                contentHash: searchIndex.contentHash,
              })
              .from(searchIndex)
              .where(
                and(
                  eq(searchIndex.vaultId, vaultId),
                  inArray(
                    searchIndex.path,
                    batch.map((file) => file.path),
                  ),
                ),
              ),
          );
          const existing = new Map<string, Map<number, string>>();
          for (const row of indexed) {
            const hashes = existing.get(row.path) ?? new Map<number, string>();
            hashes.set(row.chunkIndex, row.contentHash);
            existing.set(row.path, hashes);
          }

          const stale: SearchDocument[] = [];
          for (const file of batch) {
            if (
              file.kind === "source" &&
              file.etag !== null &&
              file.source.etag === file.etag &&
              existing.get(file.path)?.has(-1)
            )
              indexedChunks += existing.get(file.path)?.size ?? 0;
            else stale.push(file);
          }
          const markdown = yield* Effect.forEach(
            stale,
            (file) =>
              file.kind === "source"
                ? sourceRegistry.readCurrent(file.source)
                : storage
                    .readText(vaultOwner(vaultId), file.path)
                    .pipe(Effect.map((content) => parseFrontmatter(content))),
            { concurrency: READ_CONCURRENCY },
          );
          const documents: {
            readonly file: SearchDocument;
            readonly indexes: ReadonlySet<number>;
            readonly changed: readonly SearchChunk[];
          }[] = [];
          for (const [index, file] of stale.entries()) {
            const parsed = markdown[index];
            if (parsed === undefined) continue;
            const chunks = chunkDocument(parsed, file.kind);
            documents.push({
              file,
              indexes: new Set(chunks.map((chunk) => chunk.chunkIndex)),
              changed: chunks.filter(
                (chunk) => existing.get(file.path)?.get(chunk.chunkIndex) !== chunk.contentHash,
              ),
            });
          }

          type Indexed = (typeof documents)[number];
          type Piece = { readonly document: Indexed; readonly chunks: readonly SearchChunk[] };
          const rows = new Map<Indexed, PgInsertValue<typeof searchIndex>[]>();
          const unindexed = new Set<Indexed>();
          const embedPieces = (group: readonly Piece[]) =>
            Effect.result(
              embeddings.embed(
                group.flatMap((piece) => piece.chunks.map((chunk) => chunk.body)),
                { vaultId, runId, eventType: "compile", phase: `embed:search_${scope}` },
              ),
            );
          const groups: Piece[][] = [];
          let passages = 50;
          for (const document of documents) {
            for (let offset = 0; offset < document.changed.length;) {
              if (passages === 50) {
                groups.push([]);
                passages = 0;
              }
              const chunks = document.changed.slice(offset, offset + 50 - passages);
              groups.at(-1)?.push({ document, chunks });
              passages += chunks.length;
              offset += chunks.length;
            }
          }
          const embedded = yield* Effect.forEach(
            groups,
            (group) =>
              Effect.gen(function* () {
                const together = yield* embedPieces(group);
                if (
                  together._tag === "Success" ||
                  group.length === 1 ||
                  !isTimeoutError(together.failure)
                )
                  return [{ group, result: together }];
                return yield* Effect.forEach(group, (piece) =>
                  embedPieces([piece]).pipe(Effect.map((result) => ({ group: [piece], result }))),
                );
              }),
            { concurrency: config.compileEmbedConcurrency },
          );
          for (const { group, result } of embedded.flat()) {
            if (result._tag === "Failure") {
              if (!isTimeoutError(result.failure)) return yield* Effect.fail(result.failure);
              const details = errorDetails(result.failure.cause);
              const [piece] = group;
              if (piece === undefined) continue;
              yield* logger.warn("search_index.embed_timeout", {
                vault_id: vaultId,
                run_id: runId,
                scope,
                path: piece.document.file.path,
                passages: piece.chunks.length,
                error_type: details.errorType,
                error: details.message,
              });
              unindexed.add(piece.document);
              continue;
            }
            let position = 0;
            for (const { document, chunks } of group) {
              const documentRows = rows.get(document) ?? [];
              for (const chunk of chunks) {
                const embedding = result.success[position];
                position += 1;
                if (embedding === undefined)
                  throw new Error(`Embedding ${position - 1} missing from batch`);
                documentRows.push({
                  vaultId,
                  path: document.file.path,
                  chunkIndex: chunk.chunkIndex,
                  heading: chunk.heading,
                  body: chunk.body,
                  contentHash: chunk.contentHash,
                  tsv: sql`to_tsvector('english', ${chunk.body})`,
                  embedding: sql`${vectorLiteral(embedding)}::vector`,
                  updatedAt: sql`now()`,
                });
              }
              rows.set(document, documentRows);
            }
          }
          for (const document of unindexed) timedOut.push(document.file.path);

          for (const document of documents) {
            const { file, indexes } = document;
            const upserts = rows.get(document) ?? [];
            const removed = [...(existing.get(file.path)?.keys() ?? [])].some(
              (chunkIndex) => !indexes.has(chunkIndex),
            );
            const etag =
              file.kind === "source" &&
              file.etag !== null &&
              file.etag !== file.source.etag &&
              !unindexed.has(document)
                ? { id: file.source.id, value: file.etag }
                : undefined;
            if (!unindexed.has(document)) indexedChunks += indexes.size;
            if (indexes.size > 0) indexedPaths.push(file.path);
            if (upserts.length === 0 && !removed && etag === undefined) continue;
            yield* project(file, (tx) =>
              Effect.gen(function* () {
                for (let offset = 0; offset < upserts.length; offset += SEARCH_WRITE_BATCH)
                  yield* tx
                    .insert(searchIndex)
                    .values(upserts.slice(offset, offset + SEARCH_WRITE_BATCH))
                    .onConflictDoUpdate({
                      target: [searchIndex.vaultId, searchIndex.path, searchIndex.chunkIndex],
                      set: {
                        heading: sql`excluded.heading`,
                        body: sql`excluded.body`,
                        contentHash: sql`excluded.content_hash`,
                        tsv: sql`excluded.tsv`,
                        embedding: sql`excluded.embedding`,
                        updatedAt: sql`excluded.updated_at`,
                      },
                    });
                if (removed)
                  yield* tx
                    .delete(searchIndex)
                    .where(
                      and(
                        eq(searchIndex.vaultId, vaultId),
                        eq(searchIndex.path, file.path),
                        indexes.size === 0
                          ? undefined
                          : notInArray(searchIndex.chunkIndex, [...indexes]),
                      ),
                    );
                if (etag !== undefined)
                  yield* tx
                    .update(sourceDocuments)
                    .set({ etag: etag.value })
                    .where(eq(sourceDocuments.id, etag.id));
              }),
            );
          }
          yield* reportProgress(start + batch.length);
        }

        if (scope === "wiki") {
          yield* db.query((tx) =>
            tx
              .delete(searchIndex)
              .where(
                and(
                  eq(searchIndex.vaultId, vaultId),
                  like(searchIndex.path, `${prefix}%`),
                  indexedPaths.length === 0
                    ? undefined
                    : notInArray(searchIndex.path, indexedPaths),
                ),
              ),
          );
        }
        if (timedOut.length > 0)
          yield* pipeline.recordWarning(runId, {
            phase: scope === "raw" ? "ingest" : "publish",
            message:
              "documents not yet searchable (embedding timed out); the next Update retries them",
            count: timedOut.length,
            items: timedOut,
          });
        return indexedChunks;
      });

    const materializeCachedArticle = (
      vaultId: Uuid,
      runId: Uuid,
      topic: ValidatedTopic,
      output: { readonly body: string; readonly tags: readonly string[] },
    ) =>
      Effect.gen(function* () {
        const tags: string[] = [];
        const seen = new Set<string>();
        for (const raw of output.tags) {
          const tag = raw.trim().toLowerCase().replaceAll(" ", "-");
          if (tag.length === 0) throw new Error("tag is empty after normalization");
          if (!seen.has(tag)) {
            seen.add(tag);
            tags.push(tag);
          }
        }
        const path = `wiki/${topic.slug}.md`;
        const precis = openingSentence(output.body) || topic.description;
        const previousRows = yield* db.query((d) =>
          d
            .select({
              filePath: wikiArticles.filePath,
              bodyHash: wikiArticles.bodyHash,
              archived: wikiArticles.archived,
            })
            .from(wikiArticles)
            .where(and(eq(wikiArticles.vaultId, vaultId), eq(wikiArticles.topicId, topic.topicId))),
        );
        const previous = previousRows[0];
        const previousPath = previous?.filePath;
        const bodyHash = bodyContentHash(output.body);
        const added = previous === undefined || previous.archived;
        const changed = !added && previous.bodyHash !== bodyHash;
        const content = serializeFrontmatter(
          {
            topic_id: topic.topicId,
            title: topic.title,
            description: topic.description,
            tags,
          },
          output.body,
        );
        yield* storage.writeText(vaultOwner(vaultId), path, content);
        yield* db.query((d) =>
          d
            .insert(wikiArticles)
            .values({
              id: Uuid.make(crypto.randomUUID(), { disableChecks: true }),
              vaultId,
              topicId: topic.topicId,
              filePath: path,
              fileHash: fileContentHash(content),
              bodyHash,
              title: topic.title,
              precis,
              tags,
              renderRunId: runId,
              addedRunId: runId,
              archived: false,
            })
            .onConflictDoUpdate({
              target: wikiArticles.topicId,
              set: {
                filePath: path,
                fileHash: fileContentHash(content),
                bodyHash,
                title: topic.title,
                precis,
                tags,
                renderRunId: runId,
                ...(added ? { addedRunId: runId, archivedRunId: null } : {}),
                ...(changed ? { changedRunId: runId } : {}),
                archived: false,
                updatedAt: sql`now()`,
              },
            }),
        );
        // A carried topic can change slug; drop the article file at its old path.
        if (
          previousPath !== undefined &&
          previousPath !== path &&
          previousPath.startsWith("wiki/")
        ) {
          yield* storage.deletePath(vaultOwner(vaultId), previousPath);
        }
        yield* db.query((d) =>
          d
            .update(topics)
            .set({
              articleStatus: "rendered",
              renderedFromHash: topicContentHash(topic),
              updatedAt: sql`now()`,
            })
            .where(eq(topics.topicId, topic.topicId)),
        );
      });

    const applyArchiveTransitions = (
      vaultId: Uuid,
      runId: Uuid,
      transitions: readonly ArchiveTransition[],
    ) =>
      Effect.gen(function* () {
        for (const transition of transitions) {
          yield* db.query((d) =>
            d
              .update(topics)
              .set({
                articleStatus: "archived",
                supersededBy: transition.supersededBy,
                updatedAt: sql`now()`,
              })
              .where(eq(topics.topicId, transition.topicId)),
          );
          const wikiPath = `wiki/${transition.slug}.md`;
          const content = yield* Effect.result(storage.readText(vaultOwner(vaultId), wikiPath));
          if (content._tag === "Failure") continue;
          const parsed = parseFrontmatter(content.success);
          const frontmatter: Record<string, unknown> = {
            ...parsed.frontmatter,
            archived: true,
          };
          if (transition.supersededBy !== null) {
            frontmatter.superseded_by = transition.supersededBy;
          }
          const archivePath = `archive/${transition.topicId}/${transition.slug}.md`;
          yield* storage.writeText(
            vaultOwner(vaultId),
            archivePath,
            serializeFrontmatter(frontmatter, parsed.body),
          );
          yield* storage.deletePath(vaultOwner(vaultId), wikiPath);
          yield* db.query((d) =>
            d
              .update(wikiArticles)
              .set({
                filePath: archivePath,
                archived: true,
                archivedRunId: runId,
                updatedAt: sql`now()`,
              })
              .where(
                and(
                  eq(wikiArticles.vaultId, vaultId),
                  eq(wikiArticles.topicId, transition.topicId),
                ),
              ),
          );
        }
      });

    const extract = makeCompileExtract({
      config,
      db,
      embeddings,
      languageModel,
      logger,
      pipeline,
      storage,
      sourceRegistry,
      randomBytes,
      clock,
    });
    const themesPipeline = makeThemesPipeline({
      config,
      db,
      embeddings,
      languageModel,
      logger,
      pipeline,
      storage,
      archiveTransitions: applyArchiveTransitions,
      materializeArticle: materializeCachedArticle,
      rebuildWiki: (vaultId, runId) => rebuildSearchScope(vaultId, runId, "wiki"),
    });

    return {
      archiveTransitions: applyArchiveTransitions,
      ingest: (vaultId, runId) =>
        Effect.gen(function* () {
          yield* pipeline.updateProgress(
            runId,
            "ingest",
            "progress",
            progressSteps(INGEST_STEP_LABELS, "index_sources"),
          );
          yield* rebuildSearchScope(vaultId, runId, "raw");
          yield* pipeline.updateProgress(
            runId,
            "ingest",
            "completed",
            progressSteps(INGEST_STEP_LABELS, "index_sources", {
              completed: new Set(Object.keys(INGEST_STEP_LABELS)),
            }),
          );
        }),
      extract,
      abstract: themesPipeline.abstract,
      derive: (vaultId, runId, validated) =>
        Effect.gen(function* () {
          if (validated.length === 0) {
            yield* pipeline.updateProgress(
              runId,
              "derive",
              "completed",
              progressSteps(DERIVE_STEP_LABELS, "find_related", {
                completed: new Set(Object.keys(DERIVE_STEP_LABELS)),
              }),
            );
            return;
          }
          yield* pipeline.updateProgress(
            runId,
            "derive",
            "progress",
            progressSteps(DERIVE_STEP_LABELS, "find_related", {
              counts: { find_related: [0, validated.length] },
            }),
          );
          const documentOfIdea = yield* db.transaction((tx) =>
            Effect.gen(function* () {
              const requested = [...new Set(validated.flatMap((topic) => topic.subsumedIdeaIds))];
              const sources =
                requested.length === 0
                  ? []
                  : yield* tx
                      .select({ id: sourceDocuments.id })
                      .from(sourceDocuments)
                      .where(
                        and(
                          eq(sourceDocuments.vaultId, vaultId),
                          inArray(
                            sourceDocuments.id,
                            tx
                              .select({ id: ideas.documentId })
                              .from(ideas)
                              .where(inUuidArray(ideas.ideaId, requested)),
                          ),
                        ),
                      )
                      .orderBy(asc(sourceDocuments.id))
                      .for("key share");
              const live =
                sources.length === 0
                  ? []
                  : yield* tx
                      .select({ id: ideas.ideaId, documentId: ideas.documentId })
                      .from(ideas)
                      .where(
                        and(
                          inUuidArray(ideas.ideaId, requested),
                          inUuidArray(
                            ideas.documentId,
                            sources.map((source) => source.id),
                          ),
                        ),
                      );
              const liveIds = new Set(live.map((idea) => idea.id));
              yield* tx.delete(topicMembership).where(
                inArray(
                  topicMembership.topicId,
                  validated.map((topic) => topic.topicId),
                ),
              );
              const memberships = validated.flatMap((topic) =>
                topic.subsumedIdeaIds
                  .filter((ideaId) => liveIds.has(ideaId))
                  .map((ideaId) => ({ topicId: topic.topicId, ideaId })),
              );
              if (memberships.length > 0) {
                yield* tx.insert(topicMembership).select(() =>
                  uuidPairs(
                    memberships.map((membership) => membership.topicId),
                    memberships.map((membership) => membership.ideaId),
                  ),
                );
              }
              return new Map(live.map((idea) => [idea.id, idea.documentId]));
            }),
          );
          const documentSets = validated.map(
            (topic) =>
              new Set(topic.subsumedIdeaIds.flatMap((ideaId) => documentOfIdea.get(ideaId) ?? [])),
          );
          const topicsOfDocument = new Map<string, number[]>();
          documentSets.forEach((set, index) => {
            for (const documentId of set) append(topicsOfDocument, documentId, index);
          });
          const relatedRows = validated.flatMap((topic, index) => {
            const shared = new Map<number, number>();
            for (const documentId of documentSets[index] ?? [])
              for (const other of topicsOfDocument.get(documentId) ?? [])
                if (other !== index) shared.set(other, (shared.get(other) ?? 0) + 1);
            const size = documentSets[index]?.size ?? 0;
            return [...shared]
              .map(([other, count]) => ({
                topicId: topic.topicId,
                relatedTopicId: validated[other]?.topicId ?? topic.topicId,
                sharedDocuments: count,
                jaccard: count / (size + (documentSets[other]?.size ?? 0) - count),
              }))
              .toSorted(
                (left, right) =>
                  right.jaccard - left.jaccard ||
                  compareText(left.relatedTopicId, right.relatedTopicId),
              )
              .slice(0, config.compileDeriveRelatedLimit);
          });
          yield* db.query((d) =>
            d.delete(topicRelated).where(
              inUuidArray(
                topicRelated.topicId,
                validated.map((topic) => topic.topicId),
              ),
            ),
          );
          for (let offset = 0; offset < relatedRows.length; offset += SEARCH_WRITE_BATCH)
            yield* db.query((d) =>
              d.insert(topicRelated).values(relatedRows.slice(offset, offset + SEARCH_WRITE_BATCH)),
            );
          yield* pipeline.updateProgress(
            runId,
            "derive",
            "completed",
            progressSteps(DERIVE_STEP_LABELS, "find_related", {
              completed: new Set(Object.keys(DERIVE_STEP_LABELS)),
              counts: { find_related: [validated.length, validated.length] },
            }),
          );
        }),
      render: themesPipeline.render,
      verify: (_vaultId, runId) =>
        pipeline.updateProgress(
          runId,
          "verify",
          "completed",
          progressSteps(VERIFY_STEP_LABELS, "check_links", {
            completed: new Set(Object.keys(VERIFY_STEP_LABELS)),
          }),
        ),
      publish: (vaultId, runId) =>
        Effect.gen(function* () {
          yield* pipeline.updateProgress(
            runId,
            "publish",
            "progress",
            progressSteps(PUBLISH_STEP_LABELS, "publish_wiki"),
          );
          const documents = yield* db.query((d) =>
            d.select().from(sourceDocuments).where(eq(sourceDocuments.vaultId, vaultId)),
          );
          yield* pipeline.updateProgress(
            runId,
            "publish",
            "progress",
            progressSteps(PUBLISH_STEP_LABELS, "publish_wiki", {
              counts: { publish_wiki: [0, 2] },
            }),
          );
          const listed = yield* db.query((d) =>
            d
              .select({
                title: wikiArticles.title,
                filePath: wikiArticles.filePath,
                precis: wikiArticles.precis,
                inbound: sql<number>`(select count(*)::int from ${backlinks} where ${backlinks.targetArticleId} = ${wikiArticles.id})`,
              })
              .from(wikiArticles)
              .where(and(...liveArticleConditions(vaultId))),
          );
          const entry = (article: (typeof listed)[number]) =>
            `- [${article.title}](${article.filePath}) — ${article.precis.trim().replaceAll("\n", " ")}`;
          const byTitle = listed.toSorted((left, right) =>
            compareText(left.title.toLowerCase(), right.title.toLowerCase()),
          );
          const wikiLines = [
            "# Contents",
            "",
            `_${listed.length} article${listed.length === 1 ? "" : "s"}_`,
            "",
            "## Start here",
            "",
            ...byTitle
              .toSorted((left, right) => right.inbound - left.inbound)
              .slice(0, START_HERE)
              .map(entry),
            "",
            "## All articles",
            "",
            ...byTitle.map(entry),
            "",
          ];
          yield* storage.writeText(vaultOwner(vaultId), "wiki/_index.md", wikiLines.join("\n"));
          yield* pipeline.updateProgress(
            runId,
            "publish",
            "progress",
            progressSteps(PUBLISH_STEP_LABELS, "publish_wiki", {
              counts: { publish_wiki: [1, 2] },
            }),
          );
          const rawLines = [
            "# Raw Sources",
            "",
            `_${documents.length} document${documents.length === 1 ? "" : "s"}_`,
            "",
            ...documents
              .toSorted((left, right) =>
                (left.title ?? left.filePath).toLowerCase() <
                (right.title ?? right.filePath).toLowerCase()
                  ? -1
                  : (left.title ?? left.filePath).toLowerCase() >
                      (right.title ?? right.filePath).toLowerCase()
                    ? 1
                    : 0,
              )
              .map((document) => {
                const metadata = [document.genre, document.publishedDate, document.author].filter(
                  (value): value is string => value !== null && value.length > 0,
                );
                const precis = (document.precis ?? "").trim().replaceAll("\n", " ");
                return `- [${document.title ?? document.filePath}](${document.filePath})${metadata.length === 0 ? "" : ` — ${metadata.join(", ")}`}${precis.length === 0 ? "" : `  \n  ${precis}`}`;
              }),
            "",
          ];
          yield* storage.writeText(vaultOwner(vaultId), "raw/_index.md", rawLines.join("\n"));
          yield* pipeline.updateProgress(
            runId,
            "publish",
            "progress",
            progressSteps(PUBLISH_STEP_LABELS, "finalize_compile", {
              completed: new Set(["publish_wiki"]),
              counts: { publish_wiki: [2, 2] },
            }),
          );
          yield* pipeline.recordOutcome(runId);
          yield* pipeline.updateProgress(
            runId,
            "publish",
            "completed",
            progressSteps(PUBLISH_STEP_LABELS, "finalize_compile", {
              completed: new Set(Object.keys(PUBLISH_STEP_LABELS)),
              counts: { publish_wiki: [2, 2] },
            }),
          );
        }),
    } satisfies CompilePhasesShape;
  }),
);
