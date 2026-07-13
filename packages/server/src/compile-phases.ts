import { appendFile, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  backlinks,
  Database,
  searchIndex,
  sourceDocuments,
  topicLinks,
  topicMembership,
  topicRelated,
  topics,
  wikiArticles,
} from "@great-minds/database";
import type { Uuid } from "@great-minds/domain";
import { and, asc, eq, inArray, like, notInArray, sql } from "drizzle-orm";
import { Context, Effect, Exit, Layer, Schema } from "effect";

import { ClockService } from "./clock.ts";
import { makeCompileLlmCore } from "./compile-llm-core.ts";
import { AppConfig } from "./config.ts";
import { bodyContentHash, contentHash, fileContentHash } from "./crypto.ts";
import { dieDatabase } from "./db-defects.ts";
import { EmbeddingsService } from "./embeddings.ts";
import { LanguageModel } from "./llm.ts";
import { StructuredLogger } from "./logging.ts";
import {
  extractWikiLinkTargets,
  markdownParagraphs,
  parseFrontmatter,
  serializeFrontmatter,
} from "./markdown.ts";
import { PipelineRunsService, progressSteps } from "./pipeline-runs.ts";
import { VaultStorage } from "./storage.ts";
import { RandomBytesService } from "./random.ts";

export const INGEST_STEP_LABELS = { index_sources: "Indexing for search" } as const;
export const EXTRACT_STEP_LABELS = {
  extract_cards: "Extracting source cards",
  embed_ideas: "Embedding ideas",
} as const;
export const ABSTRACT_STEP_LABELS = {
  group_ideas: "Grouping ideas",
  synthesize_topics: "Synthesizing topics",
  merge_candidates: "Merging similar topics",
  canonicalize_registry: "Organizing topics",
  validate_registry: "Finalizing topics",
} as const;
export const DERIVE_STEP_LABELS = { find_related: "Connecting related topics" } as const;
export const RENDER_STEP_LABELS = {
  plan_articles: "Planning articles",
  write_articles: "Writing articles",
  index_articles: "Indexing articles",
} as const;
export const VERIFY_STEP_LABELS = { check_links: "Checking references" } as const;
export const PUBLISH_STEP_LABELS = {
  publish_wiki: "Publishing wiki",
  finalize_compile: "Finalizing",
} as const;

export const CompilePhase = Schema.Literals([
  "ingest",
  "extract",
  "abstract",
  "derive",
  "render",
  "verify",
  "publish",
] as const);
export type CompilePhase = typeof CompilePhase.Type;

export class CompilePhaseNotPorted extends Schema.TaggedErrorClass<CompilePhaseNotPorted>()(
  "CompilePhaseNotPorted",
  { phase: CompilePhase, message: Schema.String },
) {}

export class CompilePhaseFailed extends Schema.TaggedErrorClass<CompilePhaseFailed>()(
  "CompilePhaseFailed",
  { phase: CompilePhase, errorType: Schema.String, message: Schema.String },
) {}

export const CompileWorkflowError = Schema.Union([CompilePhaseNotPorted, CompilePhaseFailed]);

export const ValidatedTopic = Schema.Struct({
  topicId: Schema.String,
  slug: Schema.String,
  title: Schema.String,
  description: Schema.String,
  subsumedIdeaIds: Schema.Array(Schema.String),
  linkTargets: Schema.Array(Schema.String),
});
export type ValidatedTopic = typeof ValidatedTopic.Type;

export type ArchiveTransition = {
  readonly topicId: Uuid;
  readonly slug: string;
  readonly supersededBy: Uuid | null;
};

export const extractCacheKey = (input: {
  readonly documentId: string;
  readonly bodyHash: string;
  readonly promptHash: string;
  readonly model: string;
}) =>
  contentHash(
    `doc=${input.documentId}`,
    input.bodyHash,
    `prompt=${input.promptHash}`,
    `model=${input.model}`,
  );

export const partitionCacheKey = (ideaIds: readonly string[], targetTokens: number) =>
  contentHash(...ideaIds.toSorted(), `target=${targetTokens}`);

export const synthesizeCacheKey = (input: {
  readonly ideaIds: readonly string[];
  readonly promptHash: string;
  readonly model: string;
}) =>
  contentHash(...input.ideaIds.toSorted(), `prompt=${input.promptHash}`, `model=${input.model}`);

export const canonicalizeLocalSignature = (topic: {
  readonly title: string;
  readonly description: string;
  readonly subsumedIdeaIds: readonly string[];
}) => contentHash(topic.title, topic.description, String(topic.subsumedIdeaIds.length));

export const canonicalizeRegistryCacheKey = (input: {
  readonly orderedTopics: readonly {
    readonly title: string;
    readonly description: string;
    readonly subsumedIdeaIds: readonly string[];
  }[];
  readonly promptHash: string;
  readonly thematicHint: string;
  readonly model: string;
}) =>
  contentHash(
    ...input.orderedTopics.map(canonicalizeLocalSignature),
    `prompt=${input.promptHash}`,
    `hint=${contentHash(input.thematicHint)}`,
    `model=${input.model}`,
  );

export const canonicalizeAssignCacheKey = (input: {
  readonly batch: readonly {
    readonly localTopicId: string;
    readonly title: string;
    readonly description: string;
  }[];
  readonly registrySignature: string;
  readonly promptHash: string;
  readonly model: string;
}) =>
  contentHash(
    `registry=${input.registrySignature}`,
    ...input.batch.map(
      (topic) => `${topic.localTopicId}:${contentHash(topic.title, topic.description)}`,
    ),
    `prompt=${input.promptHash}`,
    `model=${input.model}`,
  );

export const topicContentHash = (topic: ValidatedTopic) =>
  contentHash(topic.title, topic.description, ...topic.subsumedIdeaIds.toSorted());

export const renderCacheKey = (input: {
  readonly topic: ValidatedTopic;
  readonly promptHash: string;
  readonly model: string;
}) =>
  contentHash(
    input.topic.topicId,
    topicContentHash(input.topic),
    ...input.topic.linkTargets.toSorted(),
    `prompt=${input.promptHash}`,
    `model=${input.model}`,
  );

const vectorLiteral = (embedding: readonly number[]) => `[${embedding.join(",")}]`;
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

type SearchChunk = {
  readonly path: string;
  readonly chunkIndex: number;
  readonly heading: string;
  readonly body: string;
  readonly contentHash: string;
};

const chunkDocument = (path: string, content: string): readonly SearchChunk[] => {
  const parsed = parseFrontmatter(content);
  const result: SearchChunk[] = [];
  const metadata = metadataText(parsed.frontmatter);
  if (metadata !== undefined) {
    result.push({
      path,
      chunkIndex: -1,
      heading: "",
      body: metadata,
      contentHash: contentHash("chunk", metadata),
    });
  }
  for (const paragraph of markdownParagraphs(parsed.body)) {
    const body =
      paragraph.heading.length === 0 ? paragraph.body : `${paragraph.heading}\n\n${paragraph.body}`;
    result.push({
      path,
      chunkIndex: paragraph.index,
      heading: paragraph.heading,
      body,
      contentHash: contentHash("chunk", body),
    });
  }
  return result;
};

const errorDetails = (cause: unknown) => {
  if (typeof cause === "object" && cause !== null) {
    if ("_tag" in cause) {
      return {
        errorType: String(cause._tag),
        message: "message" in cause ? String(cause.message) : String(cause),
      };
    }
    if (cause instanceof Error) return { errorType: cause.name, message: cause.message };
  }
  return { errorType: typeof cause, message: String(cause) };
};

type CompilePhasesShape = {
  readonly archiveTransitions: (
    vaultId: Uuid,
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
  readonly publish: (
    vaultId: Uuid,
    runId: Uuid,
    publishedAt: string,
  ) => Effect.Effect<void, unknown>;
  readonly flushLlmCost: (vaultId: Uuid, runId: Uuid) => Effect.Effect<void, unknown>;
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
    const storage = yield* VaultStorage;

    const rebuildSearchScope = (vaultId: Uuid, runId: Uuid, scope: "raw" | "wiki") =>
      Effect.gen(function* () {
        const prefix = `${scope}/`;
        const existing = yield* db
          .select({
            path: searchIndex.path,
            chunkIndex: searchIndex.chunkIndex,
            contentHash: searchIndex.contentHash,
          })
          .from(searchIndex)
          .where(and(eq(searchIndex.vaultId, vaultId), like(searchIndex.path, `${prefix}%`)))
          .pipe(dieDatabase);
        const existingHashes = new Map(
          existing.map((row) => [`${row.path}\u0000${row.chunkIndex}`, row.contentHash]),
        );
        const documents = yield* db
          .select({
            id: sourceDocuments.id,
            path: sourceDocuments.filePath,
            etag: sourceDocuments.etag,
          })
          .from(sourceDocuments)
          .where(eq(sourceDocuments.vaultId, vaultId))
          .pipe(dieDatabase);
        const documentsByPath = new Map(documents.map((row) => [row.path, row]));
        const files = yield* storage.listMarkdown(vaultId, scope);
        const current = new Map<string, Set<number>>();
        const changed: SearchChunk[] = [];
        const etags: { id: Uuid; etag: string }[] = [];

        if (scope === "raw") {
          yield* pipeline.updateProgress(
            runId,
            "ingest",
            "progress",
            progressSteps(INGEST_STEP_LABELS, "index_sources", {
              counts: { index_sources: [0, files.length] },
            }),
          );
        }

        for (const [fileIndex, file] of files.entries()) {
          const filename = file.path.slice(file.path.lastIndexOf("/") + 1);
          if (filename.startsWith("_")) continue;
          const document = documentsByPath.get(file.path);
          if (scope === "raw" && document !== undefined && file.etag !== null) {
            etags.push({ id: document.id as Uuid, etag: file.etag });
          }
          const hasMetadata = existingHashes.has(`${file.path}\u0000-1`);
          if (
            scope === "raw" &&
            document?.etag !== null &&
            document?.etag === file.etag &&
            file.etag !== null &&
            hasMetadata
          ) {
            current.set(
              file.path,
              new Set(
                existing.filter((row) => row.path === file.path).map((row) => row.chunkIndex),
              ),
            );
            continue;
          }
          const content = yield* storage.readText(vaultId, file.path);
          if (content.length === 0) continue;
          for (const chunk of chunkDocument(file.path, content)) {
            const indexes = current.get(file.path) ?? new Set<number>();
            indexes.add(chunk.chunkIndex);
            current.set(file.path, indexes);
            if (
              existingHashes.get(`${chunk.path}\u0000${chunk.chunkIndex}`) !== chunk.contentHash
            ) {
              changed.push(chunk);
            }
          }
          if (scope === "raw" && (fileIndex + 1) % 100 === 0) {
            yield* pipeline.updateProgress(
              runId,
              "ingest",
              "progress",
              progressSteps(INGEST_STEP_LABELS, "index_sources", {
                counts: { index_sources: [fileIndex + 1, files.length] },
              }),
            );
          }
        }

        if (scope === "raw") {
          yield* pipeline.updateProgress(
            runId,
            "ingest",
            "progress",
            progressSteps(INGEST_STEP_LABELS, "index_sources", {
              counts: { index_sources: [files.length, files.length] },
            }),
          );
        }

        for (let offset = 0; offset < changed.length; offset += 50) {
          const batch = changed.slice(offset, offset + 50);
          const embedded = yield* Effect.exit(
            Effect.tryPromise(() => embeddings.embed(batch.map((chunk) => chunk.body))),
          );
          if (Exit.isFailure(embedded)) continue;
          const rows = batch.map((chunk, index) => {
            const embedding = embedded.value[index];
            if (embedding === undefined) throw new Error(`Embedding ${index} missing from batch`);
            return {
              vaultId,
              path: chunk.path,
              chunkIndex: chunk.chunkIndex,
              heading: chunk.heading,
              body: chunk.body,
              contentHash: chunk.contentHash,
              tsv: sql`to_tsvector('english', ${chunk.body})`,
              embedding: sql`${vectorLiteral(embedding)}::vector`,
              updatedAt: sql`now()`,
            };
          });
          yield* db
            .insert(searchIndex)
            .values(rows)
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
            })
            .pipe(dieDatabase);
        }

        const currentPaths = [...current.keys()];
        if (currentPaths.length === 0) {
          yield* db
            .delete(searchIndex)
            .where(and(eq(searchIndex.vaultId, vaultId), like(searchIndex.path, `${prefix}%`)))
            .pipe(dieDatabase);
        } else {
          yield* db
            .delete(searchIndex)
            .where(
              and(
                eq(searchIndex.vaultId, vaultId),
                like(searchIndex.path, `${prefix}%`),
                notInArray(searchIndex.path, currentPaths),
              ),
            )
            .pipe(dieDatabase);
          for (const [path, indexes] of current) {
            yield* db
              .delete(searchIndex)
              .where(
                and(
                  eq(searchIndex.vaultId, vaultId),
                  eq(searchIndex.path, path),
                  notInArray(searchIndex.chunkIndex, [...indexes]),
                ),
              )
              .pipe(dieDatabase);
          }
        }
        for (const etag of etags) {
          yield* db
            .update(sourceDocuments)
            .set({ etag: etag.etag, updatedAt: sql`now()` })
            .where(eq(sourceDocuments.id, etag.id))
            .pipe(dieDatabase);
        }
        return [...current.values()].reduce((total, indexes) => total + indexes.size, 0);
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
        const content = serializeFrontmatter(
          {
            topic_id: topic.topicId,
            title: topic.title,
            description: topic.description,
            tags,
          },
          output.body,
        );
        yield* storage.writeText(vaultId, path, content);
        yield* db
          .insert(wikiArticles)
          .values({
            id: crypto.randomUUID(),
            vaultId,
            topicId: topic.topicId as Uuid,
            filePath: path,
            fileHash: fileContentHash(content),
            bodyHash: bodyContentHash(output.body),
            title: topic.title,
            precis: topic.description,
            tags,
            renderRunId: runId,
            archived: false,
          })
          .onConflictDoUpdate({
            target: wikiArticles.topicId,
            set: {
              filePath: path,
              fileHash: fileContentHash(content),
              bodyHash: bodyContentHash(output.body),
              title: topic.title,
              precis: topic.description,
              tags,
              renderRunId: runId,
              archived: false,
              updatedAt: sql`now()`,
            },
          })
          .pipe(dieDatabase);
        yield* db
          .update(topics)
          .set({
            articleStatus: "rendered",
            renderedFromHash: topicContentHash(topic),
            updatedAt: sql`now()`,
          })
          .where(eq(topics.topicId, topic.topicId as Uuid))
          .pipe(dieDatabase);
      });

    const applyArchiveTransitions = (
      vaultId: Uuid,
      transitions: readonly ArchiveTransition[],
    ) =>
      Effect.gen(function* () {
        for (const transition of transitions) {
          yield* db
            .update(topics)
            .set({
              articleStatus: "archived",
              supersededBy: transition.supersededBy,
              updatedAt: sql`now()`,
            })
            .where(eq(topics.topicId, transition.topicId))
            .pipe(dieDatabase);
          const wikiPath = `wiki/${transition.slug}.md`;
          const content = yield* Effect.result(storage.readText(vaultId, wikiPath));
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
            vaultId,
            archivePath,
            serializeFrontmatter(frontmatter, parsed.body),
          );
          yield* storage.deletePath(vaultId, wikiPath);
          yield* db
            .update(wikiArticles)
            .set({ filePath: archivePath, archived: true, updatedAt: sql`now()` })
            .where(
              and(
                eq(wikiArticles.vaultId, vaultId),
                eq(wikiArticles.topicId, transition.topicId),
              ),
            )
            .pipe(dieDatabase);
        }
      });

    const llmCore = makeCompileLlmCore({
      config,
      db,
      embeddings,
      languageModel,
      logger,
      pipeline,
      storage,
      randomBytes,
      clock,
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
      flushLlmCost: llmCore.flushCost,
      extract: llmCore.extract,
      abstract: llmCore.abstract,
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
          yield* db
            .delete(topicMembership)
            .where(
              inArray(
                topicMembership.topicId,
                validated.map((topic) => topic.topicId as Uuid),
              ),
            )
            .pipe(dieDatabase);
          const memberships = validated.flatMap((topic) =>
            topic.subsumedIdeaIds.map((ideaId) => ({
              topicId: topic.topicId as Uuid,
              ideaId: ideaId as Uuid,
            })),
          );
          if (memberships.length > 0) {
            yield* db.insert(topicMembership).values(memberships).pipe(dieDatabase);
          }
          const vaultTopicIds = yield* db
            .select({ id: topics.topicId })
            .from(topics)
            .where(eq(topics.vaultId, vaultId))
            .pipe(dieDatabase);
          if (vaultTopicIds.length > 0) {
            yield* db
              .delete(topicLinks)
              .where(
                inArray(
                  topicLinks.sourceTopicId,
                  vaultTopicIds.map((row) => row.id),
                ),
              )
              .pipe(dieDatabase);
          }
          const slugToId = new Map(validated.map((topic) => [topic.slug, topic.topicId as Uuid]));
          const links = validated.flatMap((topic) =>
            topic.linkTargets.flatMap((slug) => {
              const target = slugToId.get(slug);
              return target === undefined || target === topic.topicId
                ? []
                : [{ sourceTopicId: topic.topicId as Uuid, targetTopicId: target }];
            }),
          );
          if (links.length > 0) yield* db.insert(topicLinks).values(links).pipe(dieDatabase);

          const related = new Map<string, { id: Uuid; shared: number; jaccard: number }[]>();
          for (const topic of validated) related.set(topic.topicId, []);
          for (let leftIndex = 0; leftIndex < validated.length; leftIndex += 1) {
            const left = validated[leftIndex];
            if (left === undefined) continue;
            const leftIds = new Set(left.subsumedIdeaIds);
            for (let rightIndex = leftIndex + 1; rightIndex < validated.length; rightIndex += 1) {
              const right = validated[rightIndex];
              if (right === undefined) continue;
              const rightIds = new Set(right.subsumedIdeaIds);
              let shared = 0;
              for (const ideaId of leftIds) if (rightIds.has(ideaId)) shared += 1;
              if (shared === 0) continue;
              const jaccard = shared / (leftIds.size + rightIds.size - shared);
              related.get(left.topicId)!.push({ id: right.topicId as Uuid, shared, jaccard });
              related.get(right.topicId)!.push({ id: left.topicId as Uuid, shared, jaccard });
            }
          }
          for (const topic of validated) {
            yield* db
              .delete(topicRelated)
              .where(eq(topicRelated.topicId, topic.topicId as Uuid))
              .pipe(dieDatabase);
            const rows = (related.get(topic.topicId) ?? [])
              .toSorted(
                (left, right) => right.jaccard - left.jaccard || compareText(left.id, right.id),
              )
              .slice(0, config.compileDeriveRelatedLimit)
              .map((row) => ({
                topicId: topic.topicId as Uuid,
                relatedTopicId: row.id,
                sharedIdeas: row.shared,
                jaccard: row.jaccard,
              }));
            if (rows.length > 0) yield* db.insert(topicRelated).values(rows).pipe(dieDatabase);
          }
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
      render: llmCore.render,
      verify: (vaultId, runId) =>
        Effect.gen(function* () {
          yield* pipeline.updateProgress(
            runId,
            "verify",
            "progress",
            progressSteps(VERIFY_STEP_LABELS, "check_links"),
          );
          const rendered = yield* db
            .select()
            .from(topics)
            .where(and(eq(topics.vaultId, vaultId), eq(topics.articleStatus, "rendered")))
            .orderBy(asc(topics.title))
            .pipe(dieDatabase);
          if (rendered.length === 0) {
            yield* pipeline.updateProgress(
              runId,
              "verify",
              "completed",
              progressSteps(VERIFY_STEP_LABELS, "check_links", {
                completed: new Set(Object.keys(VERIFY_STEP_LABELS)),
              }),
            );
            return;
          }
          yield* pipeline.updateProgress(
            runId,
            "verify",
            "progress",
            progressSteps(VERIFY_STEP_LABELS, "check_links", {
              counts: { check_links: [0, rendered.length] },
            }),
          );
          const articles = yield* db
            .select()
            .from(wikiArticles)
            .where(eq(wikiArticles.vaultId, vaultId))
            .orderBy(asc(wikiArticles.filePath))
            .pipe(dieDatabase);
          const topicBySlug = new Map(rendered.map((topic) => [topic.slug, topic]));
          const articleByTopic = new Map(articles.map((article) => [article.topicId, article]));
          const sourceIds: Uuid[] = [];
          const edges: { sourceArticleId: Uuid; targetArticleId: Uuid }[] = [];
          let walked = 0;
          for (const topic of rendered) {
            const content = yield* Effect.result(
              storage.readText(vaultId, `wiki/${topic.slug}.md`),
            );
            if (content._tag === "Failure") continue;
            const source = articleByTopic.get(topic.topicId);
            if (source === undefined)
              throw new Error(`Rendered topic ${topic.topicId} has no wiki article`);
            sourceIds.push(source.id as Uuid);
            walked += 1;
            for (const path of extractWikiLinkTargets(content.success)) {
              const slug = path.slice(path.lastIndexOf("/") + 1, -3);
              const target = topicBySlug.get(slug);
              if (target === undefined || target.topicId === topic.topicId) continue;
              const targetArticle = articleByTopic.get(target.topicId);
              if (targetArticle === undefined) {
                throw new Error(`Rendered topic ${target.topicId} has no wiki article`);
              }
              edges.push({
                sourceArticleId: source.id as Uuid,
                targetArticleId: targetArticle.id as Uuid,
              });
            }
            yield* pipeline.updateProgress(
              runId,
              "verify",
              "progress",
              progressSteps(VERIFY_STEP_LABELS, "check_links", {
                counts: { check_links: [walked, rendered.length] },
              }),
            );
          }
          if (sourceIds.length > 0) {
            yield* db
              .delete(backlinks)
              .where(inArray(backlinks.sourceArticleId, sourceIds))
              .pipe(dieDatabase);
          }
          if (edges.length > 0) yield* db.insert(backlinks).values(edges).pipe(dieDatabase);
          yield* pipeline.updateProgress(
            runId,
            "verify",
            "completed",
            progressSteps(VERIFY_STEP_LABELS, "check_links", {
              completed: new Set(Object.keys(VERIFY_STEP_LABELS)),
              counts: { check_links: [walked, rendered.length] },
            }),
          );
        }),
      publish: (vaultId, runId, publishedAt) =>
        Effect.gen(function* () {
          yield* pipeline.updateProgress(
            runId,
            "publish",
            "progress",
            progressSteps(PUBLISH_STEP_LABELS, "publish_wiki"),
          );
          const rendered = yield* db
            .select()
            .from(topics)
            .where(and(eq(topics.vaultId, vaultId), eq(topics.articleStatus, "rendered")))
            .orderBy(asc(topics.title))
            .pipe(dieDatabase);
          const documents = yield* db
            .select()
            .from(sourceDocuments)
            .where(eq(sourceDocuments.vaultId, vaultId))
            .pipe(dieDatabase);
          yield* pipeline.updateProgress(
            runId,
            "publish",
            "progress",
            progressSteps(PUBLISH_STEP_LABELS, "publish_wiki", {
              counts: { publish_wiki: [0, 2] },
            }),
          );
          const wikiLines = [
            "# Wiki Index",
            "",
            `_${rendered.length} rendered article${rendered.length === 1 ? "" : "s"}_`,
            "",
            ...rendered
              .toSorted((left, right) =>
                compareText(left.title.toLowerCase(), right.title.toLowerCase()),
              )
              .map(
                (topic) =>
                  `- [${topic.title}](wiki/${topic.slug}.md) — ${topic.description.trim().replaceAll("\n", " ")}`,
              ),
            "",
          ];
          yield* storage.writeText(vaultId, "wiki/_index.md", wikiLines.join("\n"));
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
          yield* storage.writeText(vaultId, "raw/_index.md", rawLines.join("\n"));
          yield* pipeline.updateProgress(
            runId,
            "publish",
            "progress",
            progressSteps(PUBLISH_STEP_LABELS, "finalize_compile", {
              completed: new Set(["publish_wiki"]),
              counts: { publish_wiki: [2, 2] },
            }),
          );
          const counts = yield* db
            .select({
              total: sql<number>`count(*)::int`,
              rendered: sql<number>`count(*) filter (where ${topics.articleStatus} = 'rendered')::int`,
              archived: sql<number>`count(*) filter (where ${topics.articleStatus} = 'archived')::int`,
              dirty: sql<number>`count(*) filter (where ${topics.articleStatus} != 'archived' and ${topics.compiledFromHash} is not null and (${topics.renderedFromHash} is null or ${topics.renderedFromHash} != ${topics.compiledFromHash}))::int`,
            })
            .from(topics)
            .where(eq(topics.vaultId, vaultId))
            .pipe(dieDatabase);
          const chunkCounts = yield* db
            .select({
              raw: sql<number>`count(*) filter (where ${searchIndex.path} like 'raw/%')::int`,
              wiki: sql<number>`count(*) filter (where ${searchIndex.path} like 'wiki/%')::int`,
            })
            .from(searchIndex)
            .where(eq(searchIndex.vaultId, vaultId))
            .pipe(dieDatabase);
          const count = counts[0];
          const chunks = chunkCounts[0];
          if (count === undefined || chunks === undefined)
            throw new Error("Publish counts returned no row");
          const logPath = resolve(config.dataDir, ".compile", vaultId, "log.md");
          yield* Effect.tryPromise(() => mkdir(resolve(logPath, ".."), { recursive: true })).pipe(
            Effect.orDie,
          );
          const logBlock = [
            `## ${publishedAt}`,
            `- topics: ${count.total} (rendered ${count.rendered}, archived ${count.archived}, dirty ${count.dirty})`,
            `- raw docs: ${documents.length}`,
            `- chunks: ${chunks.raw} raw + ${chunks.wiki} wiki`,
            "",
            "",
          ].join("\n");
          const existingLog = yield* Effect.result(
            Effect.tryPromise({ try: () => readFile(logPath, "utf8"), catch: (error) => error }),
          );
          if (existingLog._tag === "Failure" || !existingLog.success.includes(logBlock)) {
            yield* Effect.tryPromise(() => appendFile(logPath, logBlock, "utf8")).pipe(
              Effect.orDie,
            );
          }
          yield* pipeline.updateProgress(
            runId,
            "publish",
            "completed",
            progressSteps(PUBLISH_STEP_LABELS, "finalize_compile", {
              completed: new Set(Object.keys(PUBLISH_STEP_LABELS)),
              counts: { publish_wiki: [2, 2] },
            }),
          );
          yield* llmCore.flushCost(vaultId, runId);
        }),
    } satisfies CompilePhasesShape;
  }),
);

export const phaseFailure = (phase: CompilePhase, cause: unknown) => {
  if (cause instanceof CompilePhaseNotPorted || cause instanceof CompilePhaseFailed) return cause;
  const error = errorDetails(cause);
  return new CompilePhaseFailed({ phase, ...error });
};

export const phaseLabels = (phase: CompilePhase): Record<string, string> => {
  switch (phase) {
    case "ingest":
      return INGEST_STEP_LABELS;
    case "extract":
      return EXTRACT_STEP_LABELS;
    case "abstract":
      return ABSTRACT_STEP_LABELS;
    case "derive":
      return DERIVE_STEP_LABELS;
    case "render":
      return RENDER_STEP_LABELS;
    case "verify":
      return VERIFY_STEP_LABELS;
    case "publish":
      return PUBLISH_STEP_LABELS;
  }
};
