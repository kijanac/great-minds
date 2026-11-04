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
import { Data, Effect, Option, Schema, SchemaGetter } from "effect";

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
  chunkIndex: Schema.NullOr(Schema.Int).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed(null)),
  ),
}).pipe(Schema.encodeKeys({ chunkIndex: "chunk_index" }));
type Anchor = typeof Anchor.Type;

const Idea = Schema.Struct({
  ideaId: Uuid,
  documentId: Uuid,
  kind: Schema.String,
  label: Schema.String,
  description: Schema.String,
  anchors: Schema.Array(Anchor).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed([]))),
}).pipe(Schema.encodeKeys({ ideaId: "idea_id", documentId: "document_id" }));
type Idea = typeof Idea.Type;

const MetadataText = Schema.NullOr(Schema.String).pipe(
  Schema.decodeTo(Schema.NullOr(Schema.String), {
    decode: SchemaGetter.transform(nullableString),
    encode: SchemaGetter.transform((value) => value),
  }),
  Schema.withDecodingDefaultTypeKey(Effect.succeed(null)),
);

const SourceCard = Schema.Struct({
  documentId: Uuid,
  title: Schema.String,
  precis: Schema.String,
  author: MetadataText,
  publishedDate: MetadataText,
  genre: MetadataText,
  tags: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed([]))),
  derivedExtras: Schema.Record(Schema.String, Schema.Unknown).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed({})),
  ),
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
        yield* db.query((d) => d
          .insert(llmCostEvents)
          .values({
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
          }));
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
        .replace("{kinds}", vaultConfig.kinds.join(", "))
        .replace("{vault_enriched_fields}", formatEnrichedFields(vaultConfig.enrichedFields));
      const promptHash = promptContentHash(renderedTemplate);
      yield* recordPrompt(db, promptHash, renderedTemplate);
      const responseFormat = extractResponseFormat(vaultConfig);
      const documents = yield* db.query((d) => d
        .select()
        .from(sourceDocuments)
        .where(eq(sourceDocuments.vaultId, vaultId))
        .orderBy(asc(sourceDocuments.filePath)));

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
                      { role: "user", content: renderedTemplate.replace("{doc_content}", body) },
                    ],
                    temperature: config.extractTemperature,
                    responseFormat,
                    schema: ExtractResponse,
                    logFields: { document_id: document.id, path: document.filePath },
                  });
                  const card = yield* buildSourceCard(
                    data,
                    document.id,
                    vaultConfig.kinds,
                    body,
                    mintUuid7,
                  );
                  yield* putCache(vaultId, cacheKey, { sourceCard: card });
                  cached = yield* getCache(vaultId, cacheKey);
                  if (cached === undefined)
                    return yield* new MalformedCompileCache({
                      message: `extract cache row ${cacheKey} is missing after persistence`,
                    });
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
      for (let offset = 0; offset < embeddingInputs.length; offset += 50) {
        const batch = embeddingInputs.slice(offset, offset + 50);
        const embedded = yield* Effect.result(
          embeddings.embed(batch.map(({ idea }) => `${idea.label}. ${idea.description}`.trim())),
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
                  Effect.logError("idea insert failed", {
                    cause: "cause" in error ? error.cause : error,
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
                source_paragraph_index: document.provenanceSourceParagraphIndex,
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
            embed_ideas: [embeddingInputs.length, embeddingInputs.length],
          },
        }),
      );
    });

  return extract;
};

const PYTHON_WHITESPACE = new RegExp(
  String.raw`[\t\n\v\f\r\u001c-\u001f \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+`,
  "g",
);

export const normalizePythonWhitespace = (value: string) =>
  value.replace(PYTHON_WHITESPACE, " ").replace(/^ | $/g, "");

const buildSourceCard = (
  data: typeof ExtractResponse.Type,
  documentId: Uuid,
  allowedKinds: readonly string[],
  body: string,
  mintUuid7: Effect.Effect<Uuid>,
) =>
  Effect.gen(function* () {
    const paragraphBodies = markdownParagraphs(body).map((paragraph) => ({
      index: paragraph.index,
      body: normalizePythonWhitespace(paragraph.body),
    }));
    const parsedIdeas: Idea[] = [];
    for (const idea of data.ideas) {
      const kind =
        allowedKinds.includes(idea.kind) || idea.kind === "other" ? idea.kind : "other";
      const parsedAnchors: Anchor[] = idea.anchors.map((anchor) => {
        const normalizedQuote = normalizePythonWhitespace(anchor.quote);
        return {
          claim: anchor.claim,
          quote: anchor.quote,
          chunkIndex:
            normalizedQuote.length === 0
              ? null
              : (paragraphBodies.find((paragraph) => paragraph.body.includes(normalizedQuote))
                  ?.index ?? null),
        };
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

export const codePointLength = (value: string) => [...value].length;
