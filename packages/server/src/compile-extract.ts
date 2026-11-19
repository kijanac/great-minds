import {
  anchors,
  compileCacheEntries,
  Database,
  ideas,
  llmCostEvents,
  sourceDocuments,
  vaults,
} from "@great-minds/database";
import { Uuid } from "@great-minds/domain";
import { and, asc, eq, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import type { PgInsertValue } from "drizzle-orm/pg-core";
import { Data, Effect, Option, Schema } from "effect";

import type { ClockService } from "./clock.ts";
import { EXTRACT_STEP_LABELS } from "./compile-contract.ts";
import type { AppConfigShape, ReasoningEffort } from "./config.ts";
import { contentHash, promptContentHash } from "./crypto.ts";
import { type EmbeddingsService, isTimeoutError, vectorLiteral } from "./embeddings.ts";
import { errorDetails as describeError } from "./error-details.ts";
import { type LanguageModel, type LlmMessage, stripJsonFence } from "./llm.ts";
import { recordPrompt } from "./llm-costs.ts";
import type { StructuredLogger } from "./logging.ts";
import { markdownParagraphs } from "./markdown.ts";
import { progressSteps, type PipelineRunsService } from "./pipeline-runs.ts";
import { loadPrompt } from "./prompts.ts";
import { formatUuid7, type RandomBytesService } from "./random.ts";
import type { SourceDocumentsService } from "./source-documents.ts";
import { READ_CONCURRENCY, type ContentStorage } from "./storage.ts";
import {
  failedAttempts,
  recordFailure,
  SET_ASIDE_AFTER,
  SET_ASIDE_MESSAGE,
} from "./failure-ledger.ts";
import {
  defaultVaultConfigFile,
  readVaultConfig,
  type EnrichedField,
  type VaultConfigFile,
} from "./vault-config.ts";

class MalformedLlmOutput extends Data.TaggedError("MalformedLlmOutput")<{
  readonly message: string;
  readonly issue?: Schema.SchemaError["issue"];
}> {}

class MalformedCompileCache extends Data.TaggedError("MalformedCompileCache")<{
  readonly message: string;
  readonly issue?: Schema.SchemaError["issue"];
}> {}

const errorDetails = (error: unknown): { readonly errorType: string; readonly message: string } => {
  if (
    typeof error === "object" &&
    error !== null &&
    "cause" in error &&
    error.cause !== undefined &&
    error.cause !== error
  ) {
    return describeError(error.cause);
  }
  return describeError(error);
};

type SourceRow = typeof sourceDocuments.$inferSelect;

const nullableString = (value: string | null) =>
  value !== null && value.length > 0 ? value : null;

const ExtractResponse = Schema.Struct({
  title: Schema.String,
  precis: Schema.String,
  author: Schema.NullOr(Schema.String),
  published_date: Schema.NullOr(Schema.String),
  genre: Schema.NullOr(Schema.String),
  tags: Schema.Array(Schema.String),
  ideas: Schema.Array(
    Schema.Struct({
      kind: Schema.String,
      label: Schema.String,
      description: Schema.String,
      anchors: Schema.Array(Schema.Struct({ claim: Schema.String, quote: Schema.String })),
    }),
  ),
  derived_extras: Schema.Record(Schema.String, Schema.Unknown),
});

const Anchor = Schema.Struct({
  claim: Schema.String,
  quote: Schema.String,
  chunkIndex: Schema.NullOr(Schema.Int),
}).pipe(Schema.encodeKeys({ chunkIndex: "chunk_index" }));
type Anchor = typeof Anchor.Type;

const Idea = Schema.Struct({
  ideaId: Uuid,
  documentId: Uuid,
  kind: Schema.String,
  label: Schema.String,
  description: Schema.String,
  anchors: Schema.Array(Anchor),
}).pipe(Schema.encodeKeys({ ideaId: "idea_id", documentId: "document_id" }));
type Idea = typeof Idea.Type;

const MetadataText = Schema.NullOr(Schema.String);

const SourceCard = Schema.Struct({
  documentId: Uuid,
  title: Schema.String,
  precis: Schema.String,
  author: MetadataText,
  publishedDate: MetadataText,
  genre: MetadataText,
  tags: Schema.Array(Schema.String),
  derivedExtras: Schema.Record(Schema.String, Schema.Unknown),
  ideas: Schema.Array(Idea),
})
  .pipe(
    Schema.encodeKeys({
      documentId: "document_id",
      publishedDate: "published_date",
      derivedExtras: "derived_extras",
    }),
  )
  .check(
    Schema.makeFilter((card) => card.ideas.every((idea) => idea.documentId === card.documentId)),
  );
type SourceCard = typeof SourceCard.Type;

const ExtractCache = Schema.Struct({ sourceCard: SourceCard }).pipe(
  Schema.encodeKeys({ sourceCard: "source_card" }),
);
type ExtractCacheValue = typeof ExtractCache.Type;

export const extractResponseFormat = (config: VaultConfigFile) => {
  const extrasProperties = Object.fromEntries(
    config.enrichedFields.map((field) => [
      field.name,
      field.type === "list" ? { type: "array", items: { type: "string" } } : { type: "string" },
    ]),
  );
  const anchor = {
    type: "object",
    properties: { claim: { type: "string" }, quote: { type: "string" } },
    required: ["claim", "quote"],
    additionalProperties: false,
  };
  const idea = {
    type: "object",
    properties: {
      kind: { type: "string", enum: [...config.kinds, "other"] },
      label: { type: "string" },
      description: { type: "string" },
      anchors: { type: "array", items: anchor },
    },
    required: ["kind", "label", "description", "anchors"],
    additionalProperties: false,
  };
  return {
    type: "json_schema",
    json_schema: {
      name: "source_card",
      strict: true,
      schema: {
        type: "object",
        properties: {
          title: { type: "string" },
          precis: { type: "string" },
          author: { type: ["string", "null"] },
          published_date: { type: ["string", "null"] },
          genre: { type: ["string", "null"] },
          tags: { type: "array", items: { type: "string" } },
          ideas: { type: "array", items: idea },
          derived_extras: {
            type: "object",
            properties: extrasProperties,
            required: Object.keys(extrasProperties),
            additionalProperties: false,
          },
        },
        required: [
          "title",
          "precis",
          "author",
          "published_date",
          "genre",
          "tags",
          "ideas",
          "derived_extras",
        ],
        additionalProperties: false,
      },
    },
  } as const;
};

const formatEnrichedFields = (fields: readonly EnrichedField[]) =>
  fields
    .map((field) => {
      const kindHint = field.type === "list" ? "array of strings" : "string or null";
      const description = field.description.trim() || `${field.name} value`;
      return `    - \`${field.name}\` (${kindHint}): ${description}`;
    })
    .join("\n");

type CompileExtractOptions = {
  readonly config: AppConfigShape;
  readonly db: Database["Service"];
  readonly embeddings: EmbeddingsService["Service"];
  readonly languageModel: LanguageModel["Service"];
  readonly pipeline: PipelineRunsService["Service"];
  readonly storage: ContentStorage["Service"];
  readonly sourceRegistry: SourceDocumentsService["Service"];
  readonly randomBytes: RandomBytesService["Service"];
  readonly clock: ClockService["Service"];
  readonly logger: StructuredLogger["Service"];
};

export const makeCompileExtract = (options: CompileExtractOptions) => {
  const {
    config,
    db,
    embeddings,
    languageModel,
    pipeline,
    storage,
    sourceRegistry,
    randomBytes,
    clock,
    logger,
  } = options;
  let lastMintTimestamp = -1;

  const mintUuid7 = Effect.gen(function* () {
    const [now, bytes] = yield* Effect.all([clock.now, randomBytes.bytes(16)]);
    const timestamp = Math.max(now.getTime(), lastMintTimestamp + 1);
    lastMintTimestamp = timestamp;
    return formatUuid7(timestamp, bytes);
  });

  const jsonCall: JsonCall = (input) =>
    Effect.gen(function* () {
      const totalAttempts = (input.maxParseRetries ?? 1) + 1;
      for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
        const completion = yield* languageModel.complete({
          model: input.model,
          messages: input.messages,
          temperature: Option.getOrUndefined(input.temperature),
          reasoningEffort: input.reasoningEffort,
          responseFormat: input.responseFormat,
          requestProfile: "compile",
        });
        yield* db.query((d) =>
          d.insert(llmCostEvents).values({
            userId: sql`(select ${vaults.ownerId} from ${vaults} where ${vaults.id} = ${input.vaultId})`,
            vaultId: input.vaultId,
            eventType: "compile",
            phase: input.phase,
            model: input.model,
            promptHash: input.promptHash,
            runId: input.runId,
            correlationId: `compile-${input.runId}`,
            promptTokens: completion.usage?.promptTokens ?? null,
            completionTokens: completion.usage?.completionTokens ?? null,
            costUsd: completion.usage?.cost?.toFixed(6) ?? "0.000000",
            generationId: completion.generationId ?? null,
          }),
        );
        if (completion.finishReason === "length") {
          return yield* new MalformedLlmOutput({
            message: `${input.model} output hit the token limit (finish_reason=length) and was truncated — the request is too large for a single completion`,
          });
        }
        const decoded = yield* Effect.result(
          Schema.decodeEffect(Schema.fromJsonString(input.schema))(
            stripJsonFence(completion.text.trim()),
          ),
        );
        if (decoded._tag === "Success") return decoded.success;
        const error = new MalformedLlmOutput({
          message: `${input.phase} response does not match its contract`,
          issue: decoded.failure.issue,
        });
        if (attempt === totalAttempts) return yield* error;
        const details = errorDetails(error);
        yield* logger.warn("json_llm_parse_retry", {
          run_id: input.runId,
          model: input.model,
          attempt,
          max_attempts: totalAttempts,
          error_type: details.errorType,
          error: details.message,
          ...input.logFields,
        });
      }
      return yield* Effect.die(new Error("jsonCall retry loop exited without resolution"));
    });

  const putCache = (vaultId: Uuid, cacheKey: string, value: ExtractCacheValue) =>
    Effect.gen(function* () {
      const encoded = yield* Schema.encodeEffect(ExtractCache)(value).pipe(Effect.orDie);
      yield* db.query((d) =>
        d
          .insert(compileCacheEntries)
          .values({ vaultId, phase: "extract", cacheKey, value: encoded })
          .onConflictDoNothing(),
      );
    });

  const getCache = (vaultId: Uuid, cacheKey: string) =>
    Effect.gen(function* () {
      const [row] = yield* db.query((d) =>
        d
          .select({ value: compileCacheEntries.value })
          .from(compileCacheEntries)
          .where(
            and(
              eq(compileCacheEntries.vaultId, vaultId),
              eq(compileCacheEntries.phase, "extract"),
              eq(compileCacheEntries.cacheKey, cacheKey),
            ),
          )
          .limit(1),
      );
      if (row === undefined) return undefined;
      return yield* Schema.decodeUnknownEffect(ExtractCache)(row.value).pipe(
        Effect.mapError(
          (error) =>
            new MalformedCompileCache({
              message: `extract cache row ${cacheKey} is malformed`,
              issue: error.issue,
            }),
        ),
      );
    });

  const extract = (vaultId: Uuid, runId: Uuid) =>
    Effect.gen(function* () {
      const vaultConfig = yield* readVaultConfig(storage, vaultId).pipe(
        Effect.catchTag("VaultConfigMalformed", () => Effect.succeed(defaultVaultConfigFile)),
      );
      const promptTemplate = yield* loadPrompt(storage, vaultId, "extract");
      const renderedTemplate = promptTemplate
        .replace("{kinds}", () => vaultConfig.kinds.join(", "))
        .replace("{vault_enriched_fields}", () => formatEnrichedFields(vaultConfig.enrichedFields));
      const promptHash = promptContentHash(renderedTemplate);
      yield* recordPrompt(db, promptHash, renderedTemplate);
      const responseFormat = extractResponseFormat(vaultConfig);
      const documents = yield* db.query((d) =>
        d
          .select()
          .from(sourceDocuments)
          .where(eq(sourceDocuments.vaultId, vaultId))
          .orderBy(asc(sourceDocuments.filePath)),
      );

      yield* pipeline.updateProgress(
        runId,
        "extract",
        "progress",
        progressSteps(EXTRACT_STEP_LABELS, "extract_cards", {
          counts: { extract_cards: [0, documents.length] },
        }),
      );

      const ready: { readonly document: SourceRow; readonly card: SourceCard }[] = [];
      let documentsCompleted = 0;
      const unread: string[] = [];
      const setAside: string[] = [];
      yield* Effect.forEach(
        documents,
        (document) =>
          Effect.gen(function* () {
            const result = yield* Effect.result(
              Effect.gen(function* () {
                const cacheKey = contentHash(
                  `doc=${document.id}`,
                  document.bodyHash,
                  `prompt=${promptHash}`,
                  `model=${config.extractModel}`,
                );
                let cached = yield* getCache(vaultId, cacheKey);
                if (cached === undefined) {
                  if (
                    (yield* failedAttempts(db, vaultId, "extract", cacheKey)) >= SET_ASIDE_AFTER
                  ) {
                    setAside.push(document.title ?? document.filePath);
                    return undefined;
                  }
                  const source = yield* sourceRegistry.readCurrent(document);
                  if (source === undefined) return;
                  const body = source.body;
                  const data = yield* jsonCall({
                    vaultId,
                    runId,
                    phase: "extract",
                    promptHash,
                    model: config.extractModel,
                    messages: [
                      {
                        role: "user",
                        content: renderedTemplate.replace("{doc_content}", () => body),
                      },
                    ],
                    temperature: config.extractTemperature,
                    reasoningEffort: Option.getOrUndefined(config.extractReasoningEffort),
                    responseFormat,
                    schema: ExtractResponse,
                    logFields: { document_id: document.id, path: document.filePath },
                  }).pipe(
                    Effect.tapError((error) =>
                      error instanceof MalformedLlmOutput
                        ? recordFailure(db, vaultId, "extract", cacheKey, {
                            reason: "malformed",
                            message: error.message,
                          })
                        : Effect.void,
                    ),
                  );
                  const card = yield* buildSourceCard(
                    data,
                    document.id,
                    vaultConfig.kinds,
                    body,
                    mintUuid7,
                  );
                  cached = { sourceCard: card };
                  yield* putCache(vaultId, cacheKey, cached);
                }
                if (cached.sourceCard.documentId !== document.id)
                  return yield* new MalformedCompileCache({
                    message: `extract cache row ${cacheKey} belongs to another document`,
                  });
                return cached.sourceCard;
              }),
            );
            if (result._tag === "Success") {
              if (result.success !== undefined) ready.push({ document, card: result.success });
            } else {
              unread.push(document.title ?? document.filePath);
              const details = errorDetails(result.failure);
              yield* logger.warn("doc_failed", {
                vault_id: vaultId,
                run_id: runId,
                document_id: document.id,
                path: document.filePath,
                error_type: details.errorType,
                error: details.message,
              });
            }
            documentsCompleted += 1;
            yield* pipeline.updateProgress(
              runId,
              "extract",
              "progress",
              progressSteps(EXTRACT_STEP_LABELS, "extract_cards", {
                counts: { extract_cards: [documentsCompleted, documents.length] },
              }),
            );
          }),
        { concurrency: config.compileEnrichConcurrency, discard: true },
      );
      if (unread.length > 0) {
        yield* pipeline.recordWarning(runId, {
          phase: "extract",
          message: `of ${documents.length} documents could not be read`,
          count: unread.length,
          items: unread.toSorted(),
        });
      }
      if (setAside.length > 0) {
        yield* pipeline.recordWarning(runId, {
          phase: "extract",
          message: `documents could not be read: ${SET_ASIDE_MESSAGE}`,
          count: setAside.length,
          items: setAside.toSorted(),
        });
      }

      const existing = new Set(
        (yield* db.query((d) =>
          d
            .select({ id: ideas.ideaId })
            .from(ideas)
            .where(
              and(
                eq(ideas.vaultId, vaultId),
                eq(ideas.embeddingModel, config.embeddingModel),
                isNotNull(ideas.embedding),
              ),
            ),
        )).map((row) => row.id),
      );
      const embeddingInputs = ready.flatMap(({ document, card }) =>
        card.ideas.filter((idea) => !existing.has(idea.ideaId)).map((idea) => ({ document, idea })),
      );

      yield* pipeline.updateProgress(
        runId,
        "extract",
        "progress",
        progressSteps(EXTRACT_STEP_LABELS, "embed_ideas", {
          completed: new Set(["extract_cards"]),
          counts: {
            extract_cards: [documents.length, documents.length],
            embed_ideas: [0, embeddingInputs.length],
          },
        }),
      );

      let embeddedCount = 0;
      let skippedCount = 0;
      for (let offset = 0; offset < embeddingInputs.length; offset += 50) {
        const batch = embeddingInputs.slice(offset, offset + 50);
        const embedded = yield* Effect.result(
          embeddings.embed(
            batch.map(({ idea }) => `${idea.label}. ${idea.description}`.trim()),
            { vaultId, runId, eventType: "compile", phase: "embed:ideas" },
          ),
        );
        if (embedded._tag === "Failure") {
          if (!isTimeoutError(embedded.failure)) return yield* Effect.fail(embedded.failure);
          const details = errorDetails(embedded.failure);
          yield* logger.warn("embed_batch.timeout", {
            vault_id: vaultId,
            run_id: runId,
            batch_offset: offset,
            batch_size: batch.length,
            error_type: details.errorType,
            error: details.message,
          });
          skippedCount += batch.length;
          continue;
        }
        const paired = batch.flatMap((input, index) => {
          const embedding = embedded.success[index];
          return embedding === undefined || embedding.length === 0 ? [] : [{ input, embedding }];
        });
        const byDocument = new Map<SourceRow, PgInsertValue<typeof ideas>[]>();
        for (const {
          input: { document, idea },
          embedding,
        } of paired) {
          const rows = byDocument.get(document) ?? [];
          rows.push({
            ideaId: idea.ideaId,
            vaultId,
            documentId: idea.documentId,
            kind: idea.kind,
            label: idea.label,
            description: idea.description,
            embedding: sql`${vectorLiteral(embedding)}::vector`,
            embeddingModel: config.embeddingModel,
          });
          byDocument.set(document, rows);
        }
        if (byDocument.size === 0) continue;
        for (const [document, rows] of byDocument) {
          yield* sourceRegistry.withCurrent(document, (tx) =>
            tx
              .insert(ideas)
              .values(rows)
              .onConflictDoUpdate({
                target: ideas.ideaId,
                set: {
                  label: sql`excluded.label`,
                  description: sql`excluded.description`,
                  embedding: sql`excluded.embedding`,
                  embeddingModel: sql`excluded.embedding_model`,
                },
              })
              .pipe(
                Effect.tapError((error) =>
                  logger.error("idea_insert_failed", {
                    vault_id: vaultId,
                    run_id: runId,
                    document_id: document.id,
                    error: errorDetails(error).message,
                  }),
                ),
                Effect.asVoid,
              ),
          );
        }
        embeddedCount += paired.length;
        yield* pipeline.updateProgress(
          runId,
          "extract",
          "progress",
          progressSteps(EXTRACT_STEP_LABELS, "embed_ideas", {
            completed: new Set(["extract_cards"]),
            counts: {
              extract_cards: [documents.length, documents.length],
              embed_ideas: [embeddedCount, embeddingInputs.length],
            },
          }),
        );
      }

      if (skippedCount > 0) {
        yield* pipeline.recordWarning(runId, {
          phase: "extract",
          message: `of ${embeddingInputs.length} ideas were not embedded because the embedding provider timed out; the next Update retries them`,
          count: skippedCount,
          items: [],
        });
      }

      yield* Effect.forEach(
        ready,
        ({ document, card }) =>
          sourceRegistry.rewrite(
            document,
            ({ body }) => {
              const frontmatter: Record<string, unknown> = {
                canonical_url: document.canonicalUrl,
                source_type: document.sourceType,
                url: document.url,
                origin: document.origin,
                session_id: document.provenanceSessionId,
                exchange_id: document.provenanceExchangeId,
                session_query: document.provenanceSessionQuery,
                source_doc_path: document.provenanceSourceDocPath,
                source_anchor: document.provenanceSourceAnchor,
                anchored_to: document.provenanceAnchoredTo,
                anchored_section: document.provenanceAnchoredSection,
                intent: document.provenanceIntent,
                title: card.title,
                precis: card.precis,
                author: card.author,
                date: card.publishedDate,
                genre: card.genre,
                tags: card.tags.length > 0 ? [...card.tags] : null,
                ...card.derivedExtras,
              };
              return {
                frontmatter: Object.fromEntries(
                  Object.entries(frontmatter).filter(
                    ([, value]) => value !== null && value !== undefined,
                  ),
                ),
                body,
              };
            },
            (tx) =>
              Effect.gen(function* () {
                const ideaIds = card.ideas.map((idea) => idea.ideaId);
                const stale = yield* tx
                  .select({ id: ideas.ideaId })
                  .from(ideas)
                  .where(
                    and(
                      eq(ideas.documentId, document.id),
                      ideaIds.length === 0 ? undefined : notInArray(ideas.ideaId, ideaIds),
                    ),
                  );
                if (stale.length > 0) {
                  const staleIds = stale.map((idea) => idea.id);
                  yield* tx.delete(ideas).where(inArray(ideas.ideaId, staleIds));
                }
                const persisted = yield* tx
                  .select({ id: ideas.ideaId })
                  .from(ideas)
                  .where(eq(ideas.documentId, document.id));
                const present = new Set(persisted.map((idea) => idea.id));
                if (persisted.length > 0) {
                  const rows = card.ideas
                    .filter((idea) => present.has(idea.ideaId))
                    .flatMap((idea) =>
                      idea.anchors.map((anchor, position) => ({
                        ideaId: idea.ideaId,
                        position,
                        ...anchor,
                      })),
                    );
                  const stored = yield* tx
                    .select({
                      ideaId: anchors.ideaId,
                      position: anchors.position,
                      claim: anchors.claim,
                      quote: anchors.quote,
                      chunkIndex: anchors.chunkIndex,
                    })
                    .from(anchors)
                    .where(inArray(anchors.ideaId, [...present]));
                  const signature = (anchor: (typeof stored)[number]) =>
                    JSON.stringify([
                      anchor.ideaId,
                      anchor.position,
                      anchor.claim,
                      anchor.quote,
                      anchor.chunkIndex,
                    ]);
                  const current = new Set(stored.map(signature));
                  if (
                    rows.length !== stored.length ||
                    !rows.every((row) => current.has(signature(row)))
                  ) {
                    yield* tx.delete(anchors).where(inArray(anchors.ideaId, [...present]));
                    if (rows.length > 0) yield* tx.insert(anchors).values(rows);
                  }
                }
                yield* tx
                  .update(sourceDocuments)
                  .set({
                    title: card.title,
                    precis: card.precis,
                    author: card.author,
                    publishedDate: card.publishedDate,
                    genre: card.genre,
                    tags: [...card.tags],
                    derivedExtras: card.derivedExtras,
                    updatedAt: sql`now()`,
                  })
                  .where(
                    and(
                      eq(sourceDocuments.id, document.id),
                      sql`(${sourceDocuments.title}, ${sourceDocuments.precis}, ${sourceDocuments.author},
                        ${sourceDocuments.publishedDate}, ${sourceDocuments.genre},
                        to_jsonb(${sourceDocuments.tags}), ${sourceDocuments.derivedExtras})
                        is distinct from (${card.title}::text, ${card.precis}::text, ${card.author}::text,
                        ${card.publishedDate}::text, ${card.genre}::text,
                        ${JSON.stringify(card.tags)}::jsonb, ${JSON.stringify(card.derivedExtras)}::jsonb)`,
                    ),
                  );
              }),
          ),
        { concurrency: READ_CONCURRENCY, discard: true },
      );

      yield* pipeline.updateProgress(
        runId,
        "extract",
        "completed",
        progressSteps(EXTRACT_STEP_LABELS, "embed_ideas", {
          completed: new Set(Object.keys(EXTRACT_STEP_LABELS)),
          counts: {
            extract_cards: [documents.length, documents.length],
            embed_ideas: [embeddedCount, embeddingInputs.length],
          },
        }),
      );
    });

  return extract;
};

type Word = { readonly text: string; readonly start: number; readonly end: number };

const wordsOf = (text: string): Word[] =>
  [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((match) => ({
    text: match[0].normalize("NFKD").toLowerCase(),
    start: match.index,
    end: match.index + match[0].length,
  }));

const squash = (text: string) => text.replace(/\s+/g, " ").trim();
const gram = (list: readonly string[], at: number) => `${list[at]} ${list[at + 1]} ${list[at + 2]}`;
const NEAR_MATCH = 0.8;

export const quoteLocator = (
  paragraphs: readonly { readonly index: number; readonly body: string }[],
) => {
  const squashed = paragraphs.map((paragraph) => squash(paragraph.body));
  const starts: number[] = [];
  let joined = "";
  for (const text of squashed) {
    starts.push(joined.length);
    joined += `${text} `;
  }
  const words = wordsOf(joined);
  const texts = words.map((word) => word.text);
  const chunkAt = (offset: number) =>
    paragraphs[starts.findLastIndex((start) => start <= offset)]!.index;
  const span = (from: number, to: number) => ({
    chunkIndex: chunkAt(words[from]!.start),
    quote: joined.slice(words[from]!.start, words[to]!.end),
  });
  const ranges: (readonly [number, number])[] = [];
  let next = 0;
  for (const [position] of paragraphs.entries()) {
    const from = next;
    const limit = starts[position + 1] ?? Number.POSITIVE_INFINITY;
    while (next < words.length && words[next]!.start < limit) next += 1;
    ranges.push([from, next]);
  }

  return (quote: string): { readonly chunkIndex: number; readonly quote: string } | undefined => {
    const verbatim = squash(quote);
    if (verbatim.length === 0) return undefined;
    const own = squashed.findIndex((text) => text.includes(verbatim));
    if (own >= 0) return { chunkIndex: paragraphs[own]!.index, quote };
    const across = joined.indexOf(verbatim);
    if (across >= 0) return { chunkIndex: chunkAt(across), quote };
    const wanted = wordsOf(quote).map((word) => word.text);
    if (wanted.length === 0) return undefined;
    for (let from = 0; from + wanted.length <= texts.length; from += 1)
      if (wanted.every((word, offset) => texts[from + offset] === word))
        return span(from, from + wanted.length - 1);
    if (wanted.length < 3) return undefined;
    const grams = new Set(wanted.slice(2).map((_, at) => gram(wanted, at)));
    let best: { readonly score: number; readonly from: number; readonly to: number } | undefined;
    for (const [first, end] of ranges) {
      const hit = Array.from({ length: end - first }, () => false);
      const matched = new Set<string>();
      for (let at = first; at + 2 < end; at += 1) {
        const key = gram(texts, at);
        if (!grams.has(key)) continue;
        matched.add(key);
        hit[at - first] = hit[at - first + 1] = hit[at - first + 2] = true;
      }
      const score = matched.size / grams.size;
      if (score < NEAR_MATCH || (best !== undefined && score <= best.score)) continue;
      const size = Math.min(hit.length, wanted.length + 4);
      let count = hit.slice(0, size).filter(Boolean).length;
      let top = { count, start: 0 };
      for (let start = 1; start + size <= hit.length; start += 1) {
        count += Number(hit[start + size - 1]) - Number(hit[start - 1]);
        if (count > top.count) top = { count, start };
      }
      best = {
        score,
        from: first + hit.indexOf(true, top.start),
        to: first + hit.lastIndexOf(true, top.start + size - 1),
      };
    }
    return best === undefined ? undefined : span(best.from, best.to);
  };
};

const buildSourceCard = (
  data: typeof ExtractResponse.Type,
  documentId: Uuid,
  allowedKinds: readonly string[],
  body: string,
  mintUuid7: Effect.Effect<Uuid>,
) =>
  Effect.gen(function* () {
    const locate = quoteLocator(markdownParagraphs(body));
    const parsedIdeas: Idea[] = [];
    for (const idea of data.ideas) {
      const kind = allowedKinds.includes(idea.kind) || idea.kind === "other" ? idea.kind : "other";
      const parsedAnchors: Anchor[] = idea.anchors.flatMap((anchor) => {
        const located = locate(anchor.quote);
        return located === undefined ? [] : [{ claim: anchor.claim, ...located }];
      });
      parsedIdeas.push({
        ideaId: yield* mintUuid7,
        documentId,
        kind,
        label: idea.label,
        description: idea.description,
        anchors: parsedAnchors,
      });
    }
    return {
      documentId,
      title: data.title,
      precis: data.precis,
      author: nullableString(data.author),
      publishedDate: nullableString(data.published_date),
      genre: nullableString(data.genre),
      tags: data.tags,
      derivedExtras: { ...data.derived_extras },
      ideas: parsedIdeas,
    } satisfies SourceCard;
  });

type JsonCall = <A>(input: {
  readonly vaultId: Uuid;
  readonly runId: Uuid;
  readonly phase: string;
  readonly promptHash: string;
  readonly model: string;
  readonly messages: readonly LlmMessage[];
  readonly temperature: Option.Option<number>;
  readonly reasoningEffort?: ReasoningEffort;
  readonly responseFormat: Record<string, unknown>;
  readonly schema: Schema.Decoder<A>;
  readonly maxParseRetries?: number;
  readonly logFields?: Record<string, string | number>;
}) => Effect.Effect<A, unknown>;
