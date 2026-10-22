import {
  anchors,
  compileCacheEntries,
  Database,
  ideas,
  llmCostEvents,
  sourceDocuments,
  topicMembership,
  topics,
} from "@great-minds/database";
import { Uuid } from "@great-minds/domain";
import { and, asc, eq, gt, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import type { PgInsertValue } from "drizzle-orm/pg-core";
import { Data, Effect, Option, Schema, SchemaGetter } from "effect";

import type { AppConfigShape } from "./config.ts";
import {
  ABSTRACT_STEP_LABELS,
  canonicalizeAssignCacheKey,
  canonicalizeRegistryCacheKey,
  EXTRACT_STEP_LABELS,
  LocalTopic,
  partitionCacheKey,
  RENDER_STEP_LABELS,
  renderCacheKey,
  resolveCompositionIdentity,
  synthesizeCacheKey,
  type ArchiveTransition,
  type ValidatedTopic,
} from "./compile-contract.ts";
import { contentHash, promptContentHash } from "./crypto.ts";
import { type EmbeddingsService, isTimeoutError, vectorLiteral } from "./embeddings.ts";
import { errorDetails as describeError } from "./error-details.ts";
import { type LanguageModel, type LlmMessage, stripJsonFence } from "./llm.ts";
import { recordPrompt } from "./llm-costs.ts";
import type { StructuredLogger } from "./logging.ts";
import { markdownParagraphs } from "./markdown.ts";
import type { PipelineRunsService } from "./pipeline-runs.ts";
import { progressSteps } from "./pipeline-runs.ts";
import { loadPrompt } from "./prompts.ts";
import { formatUuid7, type RandomBytesService } from "./random.ts";
import type { ContentStorage } from "./storage.ts";
import type { SourceDocumentsService } from "./source-documents.ts";
import {
  defaultVaultConfigFile,
  readVaultConfig,
  type EnrichedField,
  type VaultConfigFile,
} from "./vault-config.ts";
import type { ClockService } from "./clock.ts";

type DatabaseService = Database["Service"];
type StorageService = ContentStorage["Service"];
type PipelineService = PipelineRunsService["Service"];
type ModelService = LanguageModel["Service"];
type EmbeddingService = EmbeddingsService["Service"];
type RandomService = RandomBytesService["Service"];
type Clock = ClockService["Service"];
type Logger = StructuredLogger["Service"];

class MalformedLlmOutput extends Data.TaggedError("MalformedLlmOutput")<{
  readonly message: string;
  readonly issue?: Schema.SchemaError["issue"];
}> {}

class MalformedCompileCache extends Data.TaggedError("MalformedCompileCache")<{
  readonly message: string;
  readonly issue?: Schema.SchemaError["issue"];
}> {}

class MalformedPromptTemplate extends Data.TaggedError("MalformedPromptTemplate")<{
  readonly message: string;
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

type CanonicalDraft = {
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly mergedLocalTopicIds: readonly Uuid[];
  readonly linkTargets: readonly string[];
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

const SynthesisResponse = Schema.Struct({
  topics: Schema.optionalKey(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          slug: Schema.optionalKey(Schema.NullOr(Schema.String)),
          title: Schema.optionalKey(Schema.NullOr(Schema.String)),
          description: Schema.optionalKey(Schema.NullOr(Schema.String)),
          subsumed_idea_ids: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
        }),
      ),
    ),
  ),
});

const RegistryResponse = Schema.Struct({
  topics: Schema.Array(
    Schema.Struct({
      title: Schema.String,
      description: Schema.String,
      link_targets: Schema.Array(Schema.String),
    }),
  ),
});

const AssignmentsResponse = Schema.Struct({
  assignments: Schema.Array(Schema.Struct({ n: Schema.Int, slug: Schema.String })),
});

const CleanupResponse = Schema.Struct({
  slug_renames: Schema.optionalKey(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          canonical_tag: Schema.optionalKey(Schema.NullOr(Schema.String)),
          new_slug: Schema.optionalKey(Schema.NullOr(Schema.String)),
        }),
      ),
    ),
  ),
  supersessions: Schema.optionalKey(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          archived_tag: Schema.optionalKey(Schema.NullOr(Schema.String)),
          successor_tag: Schema.optionalKey(Schema.NullOr(Schema.String)),
        }),
      ),
    ),
  ),
});

const RenderResponse = Schema.Struct({
  body: Schema.String,
  tags: Schema.Array(Schema.String),
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

const RegistryTopic = Schema.Struct({
  slug: Schema.String,
  title: Schema.String,
  description: Schema.String,
  linkTargetTitles: Schema.Array(Schema.String),
}).pipe(Schema.encodeKeys({ linkTargetTitles: "link_target_titles" }));
type RegistryTopic = typeof RegistryTopic.Type;

const RenderTags = Schema.Array(Schema.String).pipe(
  Schema.decodeTo(Schema.Array(Schema.NonEmptyString), {
    decode: SchemaGetter.transform((tags) => [
      ...new Set(tags.map((tag) => tag.trim().toLowerCase().replaceAll(" ", "-"))),
    ]),
    encode: SchemaGetter.transform((tags) => tags),
  }),
);

const CacheSchemas = {
  extract: Schema.Struct({ sourceCard: SourceCard }).pipe(
    Schema.encodeKeys({ sourceCard: "source_card" }),
  ),
  partition: Schema.Struct({
    chunks: Schema.Array(Schema.Array(Uuid)),
    kInitial: Schema.optionalKey(Schema.Int),
    totalTokens: Schema.optionalKey(Schema.Int),
  }).pipe(Schema.encodeKeys({ kInitial: "k_initial", totalTokens: "total_tokens" })),
  synthesize: Schema.Struct({ localTopics: Schema.Array(LocalTopic) }).pipe(
    Schema.encodeKeys({ localTopics: "local_topics" }),
  ),
  canonicalize_registry: Schema.Struct({ topics: Schema.Array(RegistryTopic) }),
  canonicalize_assign: Schema.Struct({
    assign: Schema.Record(Schema.String, Schema.String).pipe(
      Schema.decodeTo(Schema.ReadonlyMap(Uuid, Schema.String), {
        decode: SchemaGetter.transform((entries) => new Map(Object.entries(entries))),
        encode: SchemaGetter.transform((entries) => Object.fromEntries(entries)),
      }),
    ),
  }),
  render: Schema.Struct({ body: Schema.String, tags: RenderTags }),
};
type CachePhase = keyof typeof CacheSchemas;
type CacheValue<Phase extends CachePhase> = (typeof CacheSchemas)[Phase]["Type"];

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

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

export const registryResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "registry",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        topics: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              title: { type: "string" },
              description: { type: "string" },
              link_targets: { type: "array", items: { type: "string" } },
            },
            required: ["title", "description", "link_targets"],
          },
        },
      },
      required: ["topics"],
    },
  },
} as const;

export const assignmentsResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "assignments",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        assignments: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: { n: { type: "integer" }, slug: { type: "string" } },
            required: ["n", "slug"],
          },
        },
      },
      required: ["assignments"],
    },
  },
} as const;

export const cleanupResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "cleanup",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        slug_renames: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: { canonical_tag: { type: "string" }, new_slug: { type: "string" } },
            required: ["canonical_tag", "new_slug"],
          },
        },
        supersessions: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              archived_tag: { type: "string" },
              successor_tag: { type: ["string", "null"] },
            },
            required: ["archived_tag", "successor_tag"],
          },
        },
      },
      required: ["slug_renames", "supersessions"],
    },
  },
} as const;

export const synthesisResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "synthesis",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        topics: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              slug: { type: "string" },
              title: { type: "string" },
              description: { type: "string" },
              subsumed_idea_ids: {
                type: "array",
                items: { type: "string", pattern: "^idea_[0-9]+$" },
              },
            },
            required: ["slug", "title", "description", "subsumed_idea_ids"],
          },
        },
      },
      required: ["topics"],
    },
  },
} as const;

export const articleResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "article",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        body: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["body", "tags"],
    },
  },
} as const;

const formatEnrichedFields = (fields: readonly EnrichedField[]) =>
  fields
    .map((field) => {
      const kindHint = field.type === "list" ? "array of strings" : "string or null";
      const description = field.description.trim() || `${field.name} value`;
      return `    - \`${field.name}\` (${kindHint}): ${description}`;
    })
    .join("\n");

type CompileLlmCoreOptions = {
  readonly config: AppConfigShape;
  readonly db: DatabaseService;
  readonly embeddings: EmbeddingService;
  readonly languageModel: ModelService;
  readonly pipeline: PipelineService;
  readonly storage: StorageService;
  readonly sourceRegistry: SourceDocumentsService["Service"];
  readonly randomBytes: RandomService;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly archiveTransitions: (
    vaultId: Uuid,
    transitions: readonly ArchiveTransition[],
  ) => Effect.Effect<void, unknown>;
  readonly materializeArticle: (
    vaultId: Uuid,
    runId: Uuid,
    topic: ValidatedTopic,
    output: { readonly body: string; readonly tags: readonly string[] },
  ) => Effect.Effect<void, unknown>;
  readonly rebuildWiki: (vaultId: Uuid, runId: Uuid) => Effect.Effect<number, unknown>;
};

export const makeCompileLlmCore = (options: CompileLlmCoreOptions) => {
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
          responseFormat: input.responseFormat,
          requestProfile: "compile",
        });
        yield* db.query((d) => d
          .insert(llmCostEvents)
          .values({
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
          error: details.message.slice(0, 300),
          ...input.logFields,
        });
      }
      return yield* Effect.die(new Error("jsonCall retry loop exited without resolution"));
    });

  const putCache: CachePutter = (vaultId, phase, cacheKey, value) =>
    Effect.gen(function* () {
      const encoded = yield* Schema.encodeEffect(CacheSchemas[phase])(value).pipe(Effect.orDie);
      yield* db.query((d) =>
        d
          .insert(compileCacheEntries)
          .values({ vaultId, phase, cacheKey, value: encoded })
          .onConflictDoNothing(),
      );
    });

  const getCache: CacheGetter = (vaultId, phase, cacheKey) =>
    Effect.gen(function* () {
      while (true) {
        const [row] = yield* db.query((d) =>
          d
            .select({ id: compileCacheEntries.id, value: compileCacheEntries.value })
            .from(compileCacheEntries)
            .where(
              and(
                eq(compileCacheEntries.vaultId, vaultId),
                eq(compileCacheEntries.phase, phase),
                eq(compileCacheEntries.cacheKey, cacheKey),
              ),
            )
            .limit(1),
        );
        if (row === undefined) return undefined;
        const decoded = yield* Effect.result(
          Schema.decodeUnknownEffect(CacheSchemas[phase])(row.value),
        );
        if (decoded._tag === "Success") return decoded.success;
        const error = new MalformedCompileCache({
          message: `${phase} cache row ${cacheKey} is malformed`,
          issue: decoded.failure.issue,
        });
        if (phase !== "partition" && phase !== "synthesize" && phase !== "render")
          return yield* error;
        const removed = yield* db.query((d) =>
          d
            .delete(compileCacheEntries)
            .where(
              and(eq(compileCacheEntries.id, row.id), eq(compileCacheEntries.value, row.value)),
            )
            .returning({ id: compileCacheEntries.id }),
        );
        if (removed.length === 0) continue;
        yield* logger.warn("compile_cache_discarded", {
          vault_id: vaultId,
          phase,
          cache_key: cacheKey,
          cache_entry_id: row.id,
          error_type: error._tag,
        });
        return undefined;
      }
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
                let cached = yield* getCache(vaultId, "extract", cacheKey);
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
                  yield* putCache(vaultId, "extract", cacheKey, { sourceCard: card });
                  cached = yield* getCache(vaultId, "extract", cacheKey);
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
              const details = errorDetails(result.failure);
              yield* logger.warn("doc_failed", {
                vault_id: vaultId,
                run_id: runId,
                document_id: document.id,
                path: document.filePath,
                error_type: details.errorType,
                error: details.message.slice(0, 300),
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
            error: details.message.slice(0, 300),
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

      for (const { document, card } of ready) {
        yield* sourceRegistry.rewrite(
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
                yield* tx.delete(anchors).where(inArray(anchors.ideaId, [...present]));
                const rows = card.ideas
                  .filter((idea) => present.has(idea.ideaId))
                  .flatMap((idea) =>
                    idea.anchors.map((anchor, position) => ({
                      ideaId: idea.ideaId,
                      position,
                      ...anchor,
                    })),
                  );
                if (rows.length > 0) yield* tx.insert(anchors).values(rows);
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
                .where(eq(sourceDocuments.id, document.id));
            }),
        );
      }

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

  const abstract = (vaultId: Uuid, runId: Uuid) =>
    runAbstract({
      vaultId,
      runId,
      config,
      db,
      storage,
      pipeline,
      logger,
      jsonCall,
      getCache,
      putCache,
      mintUuid7,
      archiveTransitions: options.archiveTransitions,
    });

  const render = (vaultId: Uuid, runId: Uuid, validated: readonly ValidatedTopic[]) =>
    runRender({
      vaultId,
      runId,
      validated,
      config,
      db,
      storage,
      pipeline,
      logger,
      jsonCall,
      getCache,
      putCache,
      materializeArticle: options.materializeArticle,
      rebuildWiki: options.rebuildWiki,
    });

  return { extract, abstract, render } as const;
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
  readonly responseFormat: Record<string, unknown>;
  readonly schema: Schema.Decoder<A>;
  readonly maxParseRetries?: number;
  readonly logFields?: Record<string, string | number>;
}) => Effect.Effect<A, unknown>;

type CacheGetter = <Phase extends CachePhase>(
  vaultId: Uuid,
  phase: Phase,
  cacheKey: string,
) => Effect.Effect<CacheValue<Phase> | undefined, MalformedCompileCache>;
type CachePutter = <Phase extends CachePhase>(
  vaultId: Uuid,
  phase: Phase,
  cacheKey: string,
  value: CacheValue<Phase>,
) => Effect.Effect<void>;

type AbstractOptions = {
  readonly vaultId: Uuid;
  readonly runId: Uuid;
  readonly config: AppConfigShape;
  readonly db: DatabaseService;
  readonly storage: StorageService;
  readonly pipeline: PipelineService;
  readonly logger: Logger;
  readonly jsonCall: JsonCall;
  readonly getCache: CacheGetter;
  readonly putCache: CachePutter;
  readonly mintUuid7: Effect.Effect<Uuid>;
  readonly archiveTransitions: (
    vaultId: Uuid,
    transitions: readonly ArchiveTransition[],
  ) => Effect.Effect<void, unknown>;
};

type IdeaContext = {
  readonly ideaId: Uuid;
  readonly documentId: Uuid;
  readonly kind: string;
  readonly label: string;
  readonly description: string;
  readonly document: SourceRow;
};

const runAbstract = (options: AbstractOptions) =>
  Effect.gen(function* () {
    const { vaultId, runId, config, db, storage, pipeline } = options;
    const rows = yield* db.query((d) => d
      .select({
        ideaId: ideas.ideaId,
        documentId: ideas.documentId,
        kind: ideas.kind,
        label: ideas.label,
        description: ideas.description,
      })
      .from(ideas)
      .where(and(eq(ideas.vaultId, vaultId), isNotNull(ideas.embedding)))
      .orderBy(asc(ideas.ideaId)));
    const docs = yield* db.query((d) => d
      .select()
      .from(sourceDocuments)
      .where(eq(sourceDocuments.vaultId, vaultId)));
    const docsById = new Map(docs.map((document) => [document.id, document]));
    const contexts: IdeaContext[] = rows.flatMap((row) => {
      const document = docsById.get(row.documentId);
      return document === undefined ? [] : [{ ...row, document }];
    });

    yield* pipeline.updateProgress(
      runId,
      "abstract",
      "progress",
      progressSteps(ABSTRACT_STEP_LABELS, "group_ideas"),
    );

    const chunks = yield* partitionIdeas(options, contexts);
    if (chunks.length === 0) {
      yield* pipeline.updateProgress(
        runId,
        "abstract",
        "completed",
        progressSteps(ABSTRACT_STEP_LABELS, "group_ideas", { completed: new Set(["group_ideas"]) }),
      );
      return [];
    }

    yield* pipeline.updateProgress(
      runId,
      "abstract",
      "progress",
      progressSteps(ABSTRACT_STEP_LABELS, "synthesize_topics", {
        completed: new Set(["group_ideas"]),
        counts: { synthesize_topics: [0, chunks.length] },
      }),
    );
    const localTopics = yield* synthesizeTopics(options, contexts, chunks);

    yield* pipeline.updateProgress(
      runId,
      "abstract",
      "progress",
      progressSteps(ABSTRACT_STEP_LABELS, "merge_candidates", {
        completed: new Set(["group_ideas", "synthesize_topics"]),
      }),
    );
    const merged = premergeTopics(localTopics, config.compilePremergeJaccardThreshold);

    yield* pipeline.updateProgress(
      runId,
      "abstract",
      "progress",
      progressSteps(ABSTRACT_STEP_LABELS, "canonicalize_registry", {
        completed: new Set(["group_ideas", "synthesize_topics", "merge_candidates"]),
      }),
    );
    const vaultConfig = yield* readVaultConfig(storage, vaultId).pipe(
      Effect.catchTag("VaultConfigMalformed", () => Effect.succeed(defaultVaultConfigFile)),
    );
    const canonicals = yield* canonicalizeTopics(options, merged, vaultConfig.thematicHint);

    yield* pipeline.updateProgress(
      runId,
      "abstract",
      "progress",
      progressSteps(ABSTRACT_STEP_LABELS, "validate_registry", {
        completed: new Set([
          "group_ideas",
          "synthesize_topics",
          "merge_candidates",
          "canonicalize_registry",
        ]),
      }),
    );
    const validated = yield* validateTopics(options, canonicals, merged);
    yield* pipeline.updateProgress(
      runId,
      "abstract",
      "completed",
      progressSteps(ABSTRACT_STEP_LABELS, "validate_registry", {
        completed: new Set([
          "group_ideas",
          "synthesize_topics",
          "merge_candidates",
          "canonicalize_registry",
          "validate_registry",
        ]),
      }),
    );
    return validated;
  });

export const codePointLength = (value: string) => [...value].length;

const estimateTokens = (idea: IdeaContext) => {
  const ideaLine = `[${idea.kind}] ${idea.label}: ${idea.description}`;
  let titlePart = `from ${idea.document.title ?? ""}`;
  if (idea.document.genre) titlePart += ` (${idea.document.genre})`;
  const docHeader = `${titlePart}; tags: ${idea.document.tags.join(",")}`;
  const precisLine = `precis: ${idea.document.precis ?? ""}`;
  return Math.max(
    1,
    Math.floor(
      (codePointLength(ideaLine) + codePointLength(docHeader) + codePointLength(precisLine)) / 4,
    ),
  );
};

const IDEA_VECTOR_PAGE_SIZE = 2000;

const loadIdeaVectors = (options: AbstractOptions, contexts: readonly IdeaContext[]) =>
  Effect.gen(function* () {
    const positions = new Map(contexts.map((idea, index) => [idea.ideaId, index]));
    let values: Float32Array | undefined;
    let dimensions = 0;
    let loaded = 0;
    let after: Uuid | undefined;
    while (true) {
      const cursor = after;
      const page = yield* options.db.query((d) => d
        .select({ ideaId: ideas.ideaId, embedding: sql<string>`${ideas.embedding}::text` })
        .from(ideas)
        .where(
          and(
            eq(ideas.vaultId, options.vaultId),
            isNotNull(ideas.embedding),
            cursor === undefined ? undefined : gt(ideas.ideaId, cursor),
          ),
        )
        .orderBy(asc(ideas.ideaId))
        .limit(IDEA_VECTOR_PAGE_SIZE));
      for (const row of page) {
        const position = positions.get(row.ideaId);
        if (position === undefined) continue;
        const components = row.embedding.slice(1, -1).split(",");
        if (values === undefined) {
          dimensions = components.length;
          values = new Float32Array(contexts.length * dimensions);
        }
        if (components.length !== dimensions) {
          return yield* Effect.die(
            new Error(
              `idea ${row.ideaId} has ${components.length} embedding dimensions, expected ${dimensions}`,
            ),
          );
        }
        const offset = position * dimensions;
        for (let index = 0; index < dimensions; index += 1) {
          values[offset + index] = Number.parseFloat(components[index] ?? "");
        }
        loaded += 1;
      }
      const last = page.at(-1);
      if (last === undefined || page.length < IDEA_VECTOR_PAGE_SIZE) break;
      after = last.ideaId;
    }
    if (values === undefined || loaded !== contexts.length) {
      return yield* Effect.die(
        new Error(`loaded ${loaded} of ${contexts.length} idea embeddings`),
      );
    }
    const matrix = values;
    return contexts.map((_idea, index) =>
      matrix.subarray(index * dimensions, (index + 1) * dimensions),
    );
  });

const partitionIdeas = (options: AbstractOptions, contexts: readonly IdeaContext[]) =>
  Effect.gen(function* () {
    if (contexts.length === 0) return [] as readonly (readonly Uuid[])[];
    const ids = contexts.map((idea) => idea.ideaId).toSorted();
    const cacheKey = partitionCacheKey(ids, options.config.compilePartitionTargetTokens);
    const cached = yield* options.getCache(options.vaultId, "partition", cacheKey);
    if (cached !== undefined) return cached.chunks;
    const tokens = contexts.map(estimateTokens);
    const totalTokens = tokens.reduce((sum, value) => sum + value, 0);
    const k = Math.min(
      contexts.length,
      Math.max(1, Math.ceil(totalTokens / options.config.compilePartitionTargetTokens)),
    );
    const matrix = yield* loadIdeaVectors(options, contexts);
    const labels = k === 1 ? contexts.map(() => 0) : yield* seededMiniBatchLabels(matrix, k);
    const chunks = yield* rebalanceChunks(
      groupLabels(labels),
      tokens,
      matrix,
      Math.trunc(
        options.config.compilePartitionTargetTokens * options.config.compilePartitionMinFactor,
      ),
      Math.trunc(
        options.config.compilePartitionTargetTokens * options.config.compilePartitionMaxFactor,
      ),
    );
    const ideaAt = (row: number) => {
      const idea = contexts[row];
      if (idea === undefined) throw new Error(`Partition index ${row} is out of range`);
      return idea.ideaId;
    };
    const result = chunks.map((chunk) => chunk.map(ideaAt));
    yield* options.putCache(options.vaultId, "partition", cacheKey, {
      chunks: result,
      kInitial: k,
      totalTokens,
    });
    return result;
  });

class Mt19937 {
  private readonly state = new Uint32Array(624);
  private index = 624;

  constructor(seed: number) {
    this.state[0] = seed >>> 0;
    for (let i = 1; i < 624; i += 1) {
      const previous = this.state[i - 1] ?? 0;
      this.state[i] = (Math.imul(1812433253, previous ^ (previous >>> 30)) + i) >>> 0;
    }
  }

  private twist() {
    for (let i = 0; i < 624; i += 1) {
      const y =
        ((this.state[i] ?? 0) & 0x80000000) | ((this.state[(i + 1) % 624] ?? 0) & 0x7fffffff);
      this.state[i] = (this.state[(i + 397) % 624] ?? 0) ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
    }
    this.index = 0;
  }

  uint32() {
    if (this.index >= 624) this.twist();
    let y = this.state[this.index] ?? 0;
    this.index += 1;
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  random() {
    const a = this.uint32() >>> 5;
    const b = this.uint32() >>> 6;
    return (a * 67_108_864 + b) / 9_007_199_254_740_992;
  }
}

const PCG64_MASK_64 = (1n << 64n) - 1n;
const PCG64_MASK_128 = (1n << 128n) - 1n;

class Pcg64Seed42 {
  private state = 274_674_114_334_540_486_603_088_602_300_644_985_544n;
  private readonly increment = 332_724_090_758_049_132_448_979_897_138_935_081_983n;
  private hasUint32 = false;
  private bufferedUint32 = 0;

  private uint64() {
    this.state =
      (this.state * 47_026_247_687_942_121_848_144_207_491_837_523_525n + this.increment) &
      PCG64_MASK_128;
    const xorshifted = ((this.state >> 64n) ^ this.state) & PCG64_MASK_64;
    const rotation = Number(this.state >> 122n);
    return (
      ((xorshifted >> BigInt(rotation)) | (xorshifted << BigInt(-rotation & 63))) & PCG64_MASK_64
    );
  }

  private uint32() {
    if (this.hasUint32) {
      this.hasUint32 = false;
      return this.bufferedUint32;
    }
    const value = this.uint64();
    this.bufferedUint32 = Number((value >> 32n) & 0xffff_ffffn);
    this.hasUint32 = true;
    return Number(value & 0xffff_ffffn);
  }

  private bounded(maximum: number) {
    let mask = maximum >>> 0;
    mask |= mask >>> 1;
    mask |= mask >>> 2;
    mask |= mask >>> 4;
    mask |= mask >>> 8;
    mask |= mask >>> 16;
    let value = 0;
    do value = (this.uint32() & mask) >>> 0;
    while (value > maximum);
    return value;
  }

  permutation(size: number) {
    const result = Array.from({ length: size }, (_unused, index) => index);
    for (let index = size - 1; index > 0; index -= 1) {
      const swap = this.bounded(index);
      [result[index], result[swap]] = [result[swap] ?? index, result[index] ?? swap];
    }
    return result;
  }
}

const squaredDistance = (left: ArrayLike<number>, right: ArrayLike<number>) => {
  let sum = 0;
  for (let i = 0; i < left.length; i += 1) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    sum += delta * delta;
  }
  return sum;
};

const chooseCenters = (matrix: readonly ArrayLike<number>[], k: number) =>
  Effect.gen(function* () {
    const rng = new Mt19937(42);
    const centers: number[][] = [];
    const first = Math.min(matrix.length - 1, Math.floor(rng.random() * matrix.length));
    centers.push(Array.from(matrix[first] ?? []));
    let closest = matrix.map((row) => squaredDistance(row, centers[0] ?? []));
    for (let centerIndex = 1; centerIndex < k; centerIndex += 1) {
      yield* Effect.yieldNow;
      const potential = closest.reduce((sum, value) => sum + value, 0);
      const trials = 2 + Math.floor(Math.log(k));
      let bestCandidate = 0;
      let bestPotential = Number.POSITIVE_INFINITY;
      let bestDistances = closest;
      for (let trial = 0; trial < trials; trial += 1) {
        const target = rng.random() * potential;
        let cumulative = 0;
        let candidate = matrix.length - 1;
        for (let row = 0; row < matrix.length; row += 1) {
          cumulative += closest[row] ?? 0;
          if (cumulative >= target) {
            candidate = row;
            break;
          }
        }
        const distances = matrix.map((row, index) =>
          Math.min(closest[index] ?? 0, squaredDistance(row, matrix[candidate] ?? [])),
        );
        const nextPotential = distances.reduce((sum, value) => sum + value, 0);
        if (nextPotential < bestPotential) {
          bestCandidate = candidate;
          bestPotential = nextPotential;
          bestDistances = distances;
        }
      }
      centers.push(Array.from(matrix[bestCandidate] ?? []));
      closest = bestDistances;
    }
    return centers;
  });

const kmeansLabels = (matrix: readonly ArrayLike<number>[], k: number) =>
  Effect.gen(function* () {
    let centers = yield* chooseCenters(matrix, k);
    let labels = matrix.map(() => 0);
    for (let iteration = 0; iteration < 100; iteration += 1) {
      yield* Effect.yieldNow;
      const next = matrix.map((row) => {
        let best = 0;
        let distance = Number.POSITIVE_INFINITY;
        for (let center = 0; center < centers.length; center += 1) {
          const candidate = squaredDistance(row, centers[center] ?? []);
          if (candidate < distance) {
            best = center;
            distance = candidate;
          }
        }
        return best;
      });
      const unchanged = next.every((label, index) => label === labels[index]);
      labels = next;
      const sums = centers.map((center) => center.map(() => 0));
      const counts = centers.map(() => 0);
      for (const [rowIndex, row] of matrix.entries()) {
        const label = labels[rowIndex] ?? 0;
        counts[label] = (counts[label] ?? 0) + 1;
        for (let dimension = 0; dimension < row.length; dimension += 1) {
          (sums[label] ?? [])[dimension] =
            ((sums[label] ?? [])[dimension] ?? 0) + (row[dimension] ?? 0);
        }
      }
      centers = centers.map((center, label) =>
        (counts[label] ?? 0) === 0
          ? center
          : (sums[label] ?? []).map((sum) => sum / (counts[label] ?? 1)),
      );
      if (unchanged && iteration > 0) break;
    }
    return labels;
  });

const seededMiniBatchLabels = (matrix: readonly ArrayLike<number>[], k: number) =>
  Effect.gen(function* () {
    const permutation = new Pcg64Seed42();
    const batchSize = 1024;
    let centers: number[][] | undefined;
    let counts: number[] = [];
    let previous: number[][] | undefined;
    for (let epoch = 0; epoch < 10; epoch += 1) {
      const order = permutation.permutation(matrix.length);
      for (let start = 0; start < order.length; start += batchSize) {
        yield* Effect.yieldNow;
        const batch = order
          .slice(start, start + batchSize)
          .map((row) => Array.from(matrix[row] ?? [], Math.fround));
        if (centers === undefined) {
          if (batch.length < k) {
            return yield* Effect.die(new Error("k-means batch has fewer rows than clusters"));
          }
          centers = (yield* chooseCenters(batch, k)).map((center) => center.map(Math.fround));
          counts = centers.map(() => 0);
        }
        const labels = batch.map((row) => {
          let best = 0;
          let distance = Number.POSITIVE_INFINITY;
          for (let center = 0; center < (centers?.length ?? 0); center += 1) {
            const candidate = squaredDistance(row, centers?.[center] ?? []);
            if (candidate < distance) {
              best = center;
              distance = candidate;
            }
          }
          return best;
        });
        for (let center = 0; center < centers.length; center += 1) {
          const members = batch.filter((_row, index) => labels[index] === center);
          if (members.length === 0) continue;
          const oldCount = counts[center] ?? 0;
          const nextCount = oldCount + members.length;
          centers[center] = (centers[center] ?? []).map((value, dimension) => {
            let sum = Math.fround(value * oldCount);
            for (const row of members) sum = Math.fround(sum + (row[dimension] ?? 0));
            return Math.fround(sum / nextCount);
          });
          counts[center] = nextCount;
        }
      }
      if (centers === undefined) return [];
      if (previous !== undefined) {
        let shiftSquared = 0;
        for (let center = 0; center < centers.length; center += 1) {
          shiftSquared += squaredDistance(centers[center] ?? [], previous[center] ?? []);
        }
        if (Math.sqrt(shiftSquared) < 1e-3) break;
      }
      previous = centers.map((center) => [...center]);
    }
    if (centers === undefined) return [];
    const labels: number[] = [];
    for (const [index, row] of matrix.entries()) {
      if (index % batchSize === 0) yield* Effect.yieldNow;
      let best = 0;
      let distance = Number.POSITIVE_INFINITY;
      for (let center = 0; center < centers.length; center += 1) {
        const candidate = squaredDistance(row, centers[center] ?? []);
        if (candidate < distance) {
          best = center;
          distance = candidate;
        }
      }
      labels.push(best);
    }
    return labels;
  });

const groupLabels = (labels: readonly number[]) => {
  const groups = new Map<number, number[]>();
  labels.forEach((label, index) => {
    const group = groups.get(label) ?? [];
    group.push(index);
    groups.set(label, group);
  });
  return [...groups.entries()].toSorted(([left], [right]) => left - right).map(([, rows]) => rows);
};

const chunkTokens = (chunk: readonly number[], tokens: readonly number[]) =>
  chunk.reduce((sum, row) => sum + (tokens[row] ?? 0), 0);

const meanVector = (chunk: readonly number[], matrix: readonly ArrayLike<number>[]) => {
  const dimensions = matrix[0]?.length ?? 0;
  const result = Array.from({ length: dimensions }, () => 0);
  for (const row of chunk) {
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      result[dimension] = (result[dimension] ?? 0) + (matrix[row]?.[dimension] ?? 0);
    }
  }
  return result.map((value) => value / Math.max(1, chunk.length));
};

const splitChunk = (
  chunk: readonly number[],
  tokens: readonly number[],
  matrix: readonly ArrayLike<number>[],
  maxTokens: number,
): Effect.Effect<number[][]> =>
  Effect.gen(function* () {
    if (chunkTokens(chunk, tokens) <= maxTokens || chunk.length < 2) return [[...chunk]];
    const ordered = [...chunk].toSorted((left, right) => left - right);
    const labels = yield* kmeansLabels(
      ordered.map((row) => matrix[row] ?? []),
      2,
    );
    let first = ordered.filter((_row, index) => labels[index] === 0);
    let second = ordered.filter((_row, index) => labels[index] === 1);
    if (first.length === 0 || second.length === 0) {
      const middle = Math.floor(ordered.length / 2);
      first = ordered.slice(0, middle);
      second = ordered.slice(middle);
    }
    return [
      ...(yield* splitChunk(first, tokens, matrix, maxTokens)),
      ...(yield* splitChunk(second, tokens, matrix, maxTokens)),
    ];
  });

const normalize = (vector: readonly number[]) => {
  const norm = Math.hypot(...vector);
  return norm === 0 ? vector.map(() => 0) : vector.map((value) => value / norm);
};

const rebalanceChunks = (
  initial: readonly (readonly number[])[],
  tokens: readonly number[],
  matrix: readonly ArrayLike<number>[],
  minTokens: number,
  maxTokens: number,
) =>
  Effect.gen(function* () {
    let chunks: number[][] = [];
    for (const chunk of initial) chunks.push(...(yield* splitChunk(chunk, tokens, matrix, maxTokens)));
    while (chunks.length > 1) {
      yield* Effect.yieldNow;
      const sizes = chunks.map((chunk) => chunkTokens(chunk, tokens));
      const undersize = sizes
        .map((size, index) => ({ size, index, first: Math.min(...(chunks[index] ?? [])) }))
        .filter((entry) => entry.size < minTokens)
        .toSorted((left, right) => left.size - right.size || left.first - right.first);
      const source = undersize[0];
      if (source === undefined) break;
      const sourceCenter = normalize(meanVector(chunks[source.index] ?? [], matrix));
      const candidates = chunks
        .map((chunk, index) => ({
          index,
          distance:
            1 -
            normalize(meanVector(chunk, matrix)).reduce(
              (sum, value, dimension) => sum + value * (sourceCenter[dimension] ?? 0),
              0,
            ),
        }))
        .filter(
          (candidate) =>
            candidate.index !== source.index &&
            (sizes[candidate.index] ?? 0) + source.size <= maxTokens,
        )
        .toSorted((left, right) => left.distance - right.distance || left.index - right.index);
      const nearest = candidates[0];
      if (nearest === undefined) break;
      const merged = [...(chunks[source.index] ?? []), ...(chunks[nearest.index] ?? [])].toSorted(
        (left, right) => left - right,
      );
      chunks = chunks.filter((_chunk, index) => index !== source.index && index !== nearest.index);
      chunks.push(merged);
    }
    return chunks;
  });

const synthesizeTopics = (
  options: AbstractOptions,
  contexts: readonly IdeaContext[],
  chunks: readonly (readonly Uuid[])[],
) =>
  Effect.gen(function* () {
    const promptTemplate = yield* loadPrompt(options.storage, options.vaultId, "synthesize");
    const revisePrompt = yield* loadPrompt(options.storage, options.vaultId, "synthesize_revise");
    const decomposePrompt = yield* loadPrompt(
      options.storage,
      options.vaultId,
      "synthesize_decompose",
    );
    const synthesizePromptHash = promptContentHash(promptTemplate);
    const revisePromptHash = promptContentHash(revisePrompt);
    const decomposePromptHash = promptContentHash(decomposePrompt);
    yield* recordPrompt(options.db, synthesizePromptHash, promptTemplate);
    yield* recordPrompt(options.db, revisePromptHash, revisePrompt);
    yield* recordPrompt(options.db, decomposePromptHash, decomposePrompt);
    // The cached outcome depends on all three prompts of the phase.
    const promptHash = contentHash(
      `synthesize=${synthesizePromptHash}`,
      `revise=${revisePromptHash}`,
      `decompose=${decomposePromptHash}`,
    );
    const contextsById = new Map(contexts.map((idea) => [idea.ideaId, idea]));
    let chunksCompleted = 0;
    const chunkTopics = yield* Effect.forEach(
      chunks,
      (chunk, chunkIdx) =>
        Effect.gen(function* () {
          const cacheKey = synthesizeCacheKey({
            ideaIds: chunk,
            promptHash,
            model: options.config.mapModel,
          });
          const cached = yield* options.getCache(options.vaultId, "synthesize", cacheKey);
          if (cached !== undefined) return cached.localTopics;
          const present = chunk.flatMap((ideaId) => {
            const idea = contextsById.get(ideaId);
            return idea === undefined ? [] : [idea];
          });
          if (present.length === 0) return [];
          const { block, tags } = synthesisIdeaBlock(present);
          const result = yield* Effect.result(
            options.jsonCall({
              vaultId: options.vaultId,
              runId: options.runId,
              phase: "synthesize",
              promptHash: synthesizePromptHash,
              model: options.config.mapModel,
              messages: [{ role: "user", content: promptTemplate.replace("{idea_block}", block) }],
              temperature: options.config.mapTemperature,
              responseFormat: synthesisResponseFormat,
              schema: SynthesisResponse,
              logFields: { chunk_idx: chunkIdx },
            }),
          );
          if (result._tag === "Failure") {
            const details = errorDetails(result.failure);
            yield* options.logger.warn("chunk_failed", {
              vault_id: options.vaultId,
              run_id: options.runId,
              chunk_idx: chunkIdx,
              error_type: details.errorType,
              error: details.message.slice(0, 300),
            });
            return [];
          }
          const parsed = yield* parseSynthesisResponse(
            result.success,
            chunkIdx,
            tags,
            options.mintUuid7,
          );
          const resolved = yield* resolveChunkGranularity(options, {
            chunkIdx,
            topics: parsed,
            ideaBlock: block,
            tags,
            contexts: present,
            revisePrompt,
            revisePromptHash,
            decomposePrompt,
            decomposePromptHash,
          });
          yield* options.putCache(options.vaultId, "synthesize", cacheKey, {
            localTopics: resolved,
          });
          return resolved;
        }).pipe(
          Effect.tap(() =>
            Effect.gen(function* () {
              chunksCompleted += 1;
              yield* options.pipeline.updateProgress(
                options.runId,
                "abstract",
                "progress",
                progressSteps(ABSTRACT_STEP_LABELS, "synthesize_topics", {
                  completed: new Set(["group_ideas"]),
                  counts: { synthesize_topics: [chunksCompleted, chunks.length] },
                }),
              );
            }),
          ),
        ),
      { concurrency: options.config.compileEnrichConcurrency },
    );
    return chunkTopics.flat();
  });

const synthesisIdeaBlock = (ideasInChunk: readonly IdeaContext[]) => {
  const byDocument = new Map<string, IdeaContext[]>();
  for (const idea of ideasInChunk) {
    const group = byDocument.get(idea.documentId) ?? [];
    group.push(idea);
    byDocument.set(idea.documentId, group);
  }
  const lines: string[] = [];
  const tags = new Map<string, Uuid>();
  let counter = 0;
  for (const documentId of [...byDocument.keys()].toSorted()) {
    const group = byDocument.get(documentId) ?? [];
    const document = group[0]?.document;
    if (document === undefined) continue;
    lines.push(`## Doc: ${document.title ?? ""}`);
    if (document.genre) lines.push(`Genre: ${document.genre}`);
    if (document.precis) lines.push(`Precis: ${document.precis}`);
    if (document.tags.length > 0) lines.push(`Tags: ${document.tags.join(", ")}`);
    lines.push("Ideas:");
    for (const idea of group) {
      counter += 1;
      const tag = `idea_${counter}`;
      tags.set(tag, idea.ideaId);
      lines.push(`- ${tag} [${idea.kind}] ${idea.label}: ${idea.description}`);
    }
    lines.push("");
  }
  return { block: lines.join("\n"), tags } as const;
};

const normalizeSlug = (slug: string) =>
  slug
    .trim()
    .toLowerCase()
    .replaceAll(" ", "-")
    .replaceAll("_", "-")
    .replace(/[^a-z0-9-]+/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

const parseSynthesisResponse = (
  data: typeof SynthesisResponse.Type,
  chunkIdx: number,
  tags: ReadonlyMap<string, Uuid>,
  mintUuid7: Effect.Effect<Uuid>,
) =>
  Effect.gen(function* () {
    const out: LocalTopic[] = [];
    for (const topic of data.topics ?? []) {
      const slug = normalizeSlug(topic.slug ?? "");
      const title = (topic.title ?? "").trim();
      const description = (topic.description ?? "").trim();
      const ids = [
        ...new Set(
          (topic.subsumed_idea_ids ?? []).flatMap((tag) => {
            const ideaId = tags.get(tag);
            return ideaId === undefined ? [] : [ideaId];
          }),
        ),
      ].toSorted();
      if (slug.length === 0 || title.length === 0 || ids.length === 0) continue;
      out.push({
        localTopicId: yield* mintUuid7,
        chunkIdx,
        slug,
        title,
        description,
        subsumedIdeaIds: ids,
      });
    }
    return out;
  });

const NESTING_CONTAINMENT_THRESHOLD = 0.8;
const DECOMPOSE_COVERAGE_THRESHOLD = 0.5;
const DECOMPOSE_MIN_IDEAS = 20;
const MAX_NESTING_REVISE_ROUNDS = 2;
const MIN_RESIDUE_IDEAS = 5;

export type NestingViolation = {
  readonly umbrella: number;
  readonly facets: readonly number[];
};

// B nests in A when A holds >= threshold of B's ideas and B is strictly smaller.
export const findNestingViolations = (
  topics: readonly LocalTopic[],
): readonly NestingViolation[] => {
  const sets = topics.map((topic) => new Set(topic.subsumedIdeaIds));
  const out: NestingViolation[] = [];
  for (let a = 0; a < topics.length; a += 1) {
    const container = sets[a];
    if (container === undefined) continue;
    const facets: number[] = [];
    for (let b = 0; b < topics.length; b += 1) {
      if (a === b) continue;
      const inner = sets[b];
      if (inner === undefined || inner.size === 0 || inner.size >= container.size) continue;
      let overlap = 0;
      for (const ideaId of inner) if (container.has(ideaId)) overlap += 1;
      if (overlap / inner.size >= NESTING_CONTAINMENT_THRESHOLD) facets.push(b);
    }
    if (facets.length > 0) out.push({ umbrella: a, facets });
  }
  return out;
};

// Mechanical floor: umbrellas shrink to their residue (computed on original
// sets); a tiny residue is dropped only when every idea in it survives in
// another final topic.
export const applyNestingFloor = (
  topics: readonly LocalTopic[],
  violations: readonly NestingViolation[],
): readonly LocalTopic[] => {
  const originalSets = topics.map((topic) => new Set(topic.subsumedIdeaIds));
  const residues = new Map<number, Set<Uuid>>();
  for (const violation of violations) {
    const original = originalSets[violation.umbrella];
    if (original === undefined) continue;
    const residue = new Set(original);
    for (const facet of violation.facets) {
      for (const ideaId of originalSets[facet] ?? []) residue.delete(ideaId);
    }
    residues.set(violation.umbrella, residue);
  }
  const finalSet = (index: number) =>
    residues.get(index) ?? originalSets[index] ?? new Set<Uuid>();
  const out: LocalTopic[] = [];
  topics.forEach((topic, index) => {
    const ids = finalSet(index);
    if (ids.size === 0) return;
    if (residues.has(index) && ids.size < MIN_RESIDUE_IDEAS) {
      const coveredElsewhere = [...ids].every((ideaId) =>
        topics.some((_other, other) => other !== index && finalSet(other).has(ideaId)),
      );
      if (coveredElsewhere) return;
    }
    out.push(
      ids.size === topic.subsumedIdeaIds.length
        ? topic
        : { ...topic, subsumedIdeaIds: [...ids].toSorted() },
    );
  });
  return out;
};

const coveredIdeaIds = (topics: readonly LocalTopic[]) => {
  const out = new Set<string>();
  for (const topic of topics) for (const ideaId of topic.subsumedIdeaIds) out.add(ideaId);
  return out;
};

const coversAll = (covered: ReadonlySet<string>, required: Iterable<string>) => {
  for (const ideaId of required) if (!covered.has(ideaId)) return false;
  return true;
};

const reviseTopicBlock = (
  topics: readonly LocalTopic[],
  tagsByIdeaId: ReadonlyMap<string, string>,
) =>
  topics
    .map((topic, index) =>
      [
        `## t_${index + 1}: ${topic.title}`,
        topic.description,
        `subsumed_idea_ids: ${topic.subsumedIdeaIds
          .flatMap((ideaId) => {
            const tag = tagsByIdeaId.get(ideaId);
            return tag === undefined ? [] : [tag];
          })
          .join(", ")}`,
      ].join("\n"),
    )
    .join("\n\n");

const nestingViolationBlock = (
  topics: readonly LocalTopic[],
  violations: readonly NestingViolation[],
) =>
  violations
    .flatMap((violation) =>
      violation.facets.map(
        (facet) =>
          `- "${topics[violation.umbrella]?.title ?? ""}" contains "${topics[facet]?.title ?? ""}"`,
      ),
    )
    .join("\n");

type ChunkGranularityInput = {
  readonly chunkIdx: number;
  readonly topics: readonly LocalTopic[];
  readonly ideaBlock: string;
  readonly tags: ReadonlyMap<string, Uuid>;
  readonly contexts: readonly IdeaContext[];
  readonly revisePrompt: string;
  readonly revisePromptHash: string;
  readonly decomposePrompt: string;
  readonly decomposePromptHash: string;
};

const resolveChunkGranularity = (options: AbstractOptions, input: ChunkGranularityInput) =>
  Effect.gen(function* () {
    let topics = input.topics;
    let violations = findNestingViolations(topics);
    for (let round = 0; round < MAX_NESTING_REVISE_ROUNDS && violations.length > 0; round += 1) {
      const tagsByIdeaId = new Map([...input.tags].map(([tag, ideaId]) => [ideaId, tag]));
      const content = input.revisePrompt
        .replace("{violation_block}", nestingViolationBlock(topics, violations))
        .replace("{topic_block}", reviseTopicBlock(topics, tagsByIdeaId))
        .replace("{idea_block}", input.ideaBlock);
      const result = yield* Effect.result(
        options.jsonCall({
          vaultId: options.vaultId,
          runId: options.runId,
          phase: "synthesize_revise",
          promptHash: input.revisePromptHash,
          model: options.config.mapModel,
          messages: [{ role: "user", content }],
          temperature: options.config.mapTemperature,
          responseFormat: synthesisResponseFormat,
          schema: SynthesisResponse,
          logFields: { chunk_idx: input.chunkIdx, phase: "synthesize_revise" },
        }),
      );
      if (result._tag === "Failure") {
        const details = errorDetails(result.failure);
        yield* options.logger.warn("synthesize_revise_failed", {
          vault_id: options.vaultId,
          run_id: options.runId,
          chunk_idx: input.chunkIdx,
          error_type: details.errorType,
          error: details.message.slice(0, 300),
        });
        break;
      }
      const revised = yield* parseSynthesisResponse(
        result.success,
        input.chunkIdx,
        input.tags,
        options.mintUuid7,
      );
      // Resolution never reduces idea coverage; curation happens at first emission only.
      if (revised.length === 0 || !coversAll(coveredIdeaIds(revised), coveredIdeaIds(topics))) {
        yield* options.logger.warn("synthesize_revise_rejected", {
          vault_id: options.vaultId,
          run_id: options.runId,
          chunk_idx: input.chunkIdx,
          topics: revised.length,
        });
        break;
      }
      topics = revised;
      violations = findNestingViolations(topics);
    }
    if (violations.length > 0) {
      const beforeCovered = coveredIdeaIds(topics);
      topics = applyNestingFloor(topics, violations);
      if (!coversAll(coveredIdeaIds(topics), beforeCovered)) {
        return yield* Effect.die(
          new Error(`nesting floor lost idea coverage in chunk ${input.chunkIdx}`),
        );
      }
      yield* options.logger.warn("synthesize_nesting_floor", {
        vault_id: options.vaultId,
        run_id: options.runId,
        chunk_idx: input.chunkIdx,
        umbrella_count: violations.length,
      });
    }

    const chunkIdeaCount = input.contexts.length;
    const contextsById = new Map(input.contexts.map((idea) => [idea.ideaId, idea]));
    const next: LocalTopic[] = [];
    let decomposed = false;
    for (const [topicIdx, topic] of topics.entries()) {
      const oversized =
        topic.subsumedIdeaIds.length >= DECOMPOSE_MIN_IDEAS &&
        topic.subsumedIdeaIds.length >= chunkIdeaCount * DECOMPOSE_COVERAGE_THRESHOLD;
      if (!oversized) {
        next.push(topic);
        continue;
      }
      const subset = topic.subsumedIdeaIds.flatMap((ideaId) => {
        const idea = contextsById.get(ideaId);
        return idea === undefined ? [] : [idea];
      });
      const { block, tags } = synthesisIdeaBlock(subset);
      const content = input.decomposePrompt
        .replace("{topic_title}", topic.title)
        .replace("{topic_description}", topic.description)
        .replace("{idea_block}", block);
      const result = yield* Effect.result(
        options.jsonCall({
          vaultId: options.vaultId,
          runId: options.runId,
          phase: "synthesize_decompose",
          promptHash: input.decomposePromptHash,
          model: options.config.mapModel,
          messages: [{ role: "user", content }],
          temperature: options.config.mapTemperature,
          responseFormat: synthesisResponseFormat,
          schema: SynthesisResponse,
          logFields: { chunk_idx: input.chunkIdx, phase: "synthesize_decompose" },
        }),
      );
      if (result._tag === "Failure") {
        const details = errorDetails(result.failure);
        yield* options.logger.warn("synthesize_decompose_failed", {
          vault_id: options.vaultId,
          run_id: options.runId,
          chunk_idx: input.chunkIdx,
          error_type: details.errorType,
          error: details.message.slice(0, 300),
        });
        next.push(topic);
        continue;
      }
      const replacement = yield* parseSynthesisResponse(
        result.success,
        input.chunkIdx,
        tags,
        options.mintUuid7,
      );
      // Accept only replacements that keep every idea covered that no other
      // topic in the current working state holds; the model may return a
      // single refined topic.
      const othersCovered = coveredIdeaIds([...next, ...topics.slice(topicIdx + 1)]);
      const required = topic.subsumedIdeaIds.filter((ideaId) => !othersCovered.has(ideaId));
      if (replacement.length === 0 || !coversAll(coveredIdeaIds(replacement), required)) {
        yield* options.logger.warn("synthesize_decompose_rejected", {
          vault_id: options.vaultId,
          run_id: options.runId,
          chunk_idx: input.chunkIdx,
          topics: replacement.length,
        });
        next.push(topic);
        continue;
      }
      decomposed = true;
      next.push(...replacement);
    }
    topics = next;
    if (decomposed) {
      const residual = findNestingViolations(topics);
      if (residual.length > 0) {
        const beforeCovered = coveredIdeaIds(topics);
        topics = applyNestingFloor(topics, residual);
        if (!coversAll(coveredIdeaIds(topics), beforeCovered)) {
          return yield* Effect.die(
            new Error(`nesting floor lost idea coverage in chunk ${input.chunkIdx}`),
          );
        }
        yield* options.logger.warn("synthesize_nesting_floor", {
          vault_id: options.vaultId,
          run_id: options.runId,
          chunk_idx: input.chunkIdx,
          umbrella_count: residual.length,
        });
      }
    }
    return topics;
  });

export const premergeTopics = (
  localTopics: readonly LocalTopic[],
  jaccardThreshold: number,
): readonly LocalTopic[] => {
  if (localTopics.length < 2) return localTopics;
  const ordered = [...localTopics].toSorted(
    (left, right) =>
      left.chunkIdx - right.chunkIdx || compareText(left.localTopicId, right.localTopicId),
  );
  const parent = ordered.map((_topic, index) => index);
  const find = (value: number): number => {
    let node = value;
    while ((parent[node] ?? node) !== node) {
      parent[node] = parent[parent[node] ?? node] ?? node;
      node = parent[node] ?? node;
    }
    return node;
  };
  const union = (left: number, right: number) => {
    const a = find(left);
    const b = find(right);
    if (a === b) return false;
    parent[Math.max(a, b)] = Math.min(a, b);
    return true;
  };
  const unionGroups = (key: (topic: LocalTopic) => string) => {
    const groups = new Map<string, number[]>();
    ordered.forEach((topic, index) => {
      const group = groups.get(key(topic)) ?? [];
      group.push(index);
      groups.set(key(topic), group);
    });
    for (const group of groups.values()) {
      for (let index = 1; index < group.length; index += 1) union(group[0] ?? 0, group[index] ?? 0);
    }
  };
  unionGroups((topic) => topic.slug);
  unionGroups((topic) => topic.title.trim().toLowerCase());
  for (let left = 0; left < ordered.length; left += 1) {
    for (let right = left + 1; right < ordered.length; right += 1) {
      if (find(left) === find(right)) continue;
      const a = new Set(ordered[left]?.subsumedIdeaIds ?? []);
      const b = new Set(ordered[right]?.subsumedIdeaIds ?? []);
      if (a.size === 0 || b.size === 0) continue;
      let intersection = 0;
      for (const ideaId of a) if (b.has(ideaId)) intersection += 1;
      const jaccard = intersection / (a.size + b.size - intersection);
      if (jaccard > jaccardThreshold) union(left, right);
    }
  }
  const groups = new Map<number, number[]>();
  ordered.forEach((_topic, index) => {
    const root = find(index);
    const group = groups.get(root) ?? [];
    group.push(index);
    groups.set(root, group);
  });
  return [...groups.values()]
    .map((group) => {
      const representative = ordered[group[0] ?? 0];
      if (representative === undefined) throw new Error("premerge representative missing");
      return {
        ...representative,
        subsumedIdeaIds: [
          ...new Set(group.flatMap((index) => ordered[index]?.subsumedIdeaIds ?? [])),
        ].toSorted(),
      };
    })
    .toSorted((left, right) => compareText(left.slug, right.slug));
};

const slugifyRegistry = (title: string, seen: Set<string>) => {
  const base =
    title
      .toLowerCase()
      .replaceAll("'", "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "topic";
  let slug = base;
  let suffix = 2;
  while (seen.has(slug)) {
    slug = `${base}-${suffix}`;
    suffix += 1;
  }
  seen.add(slug);
  return slug;
};

const canonicalizeTopics = (
  options: AbstractOptions,
  localTopics: readonly LocalTopic[],
  thematicHint: string,
) =>
  Effect.gen(function* () {
    if (localTopics.length === 0) return [] as readonly CanonicalDraft[];
    const ordered = [...localTopics].toSorted((left, right) =>
      compareText(left.localTopicId, right.localTopicId),
    );
    const registryTemplate = yield* loadPrompt(
      options.storage,
      options.vaultId,
      "canonicalize_registry",
    );
    const registryPromptHash = promptContentHash(registryTemplate);
    yield* recordPrompt(options.db, registryPromptHash, registryTemplate);
    const registryCacheKey = canonicalizeRegistryCacheKey({
      orderedTopics: ordered,
      promptHash: registryPromptHash,
      thematicHint,
      model: options.config.reduceModel,
    });
    const cachedRegistry = yield* options.getCache(
      options.vaultId,
      "canonicalize_registry",
      registryCacheKey,
    );
    let registry: readonly RegistryTopic[];
    if (cachedRegistry !== undefined) {
      registry = cachedRegistry.topics;
    } else {
      const hintBlock = thematicHint.trim()
        ? `The wiki's editorial lens for this vault:\n\n${thematicHint.trim()}\n\n`
        : "";
      const localBlock = ordered
        .map(
          (topic) =>
            `${topic.title} :: ${topic.description} [${topic.subsumedIdeaIds.length} ideas]`,
        )
        .map((line) => `- ${line}`)
        .join("\n");
      const data = yield* options.jsonCall({
        vaultId: options.vaultId,
        runId: options.runId,
        phase: "canonicalize_registry",
        promptHash: registryPromptHash,
        model: options.config.reduceModel,
        messages: [
          {
            role: "user",
            content: registryTemplate
              .replace("{thematic_hint_block}", hintBlock)
              .replace("{local_topic_block}", localBlock),
          },
        ],
        temperature: options.config.reduceTemperature,
        responseFormat: registryResponseFormat,
        schema: RegistryResponse,
        logFields: { vault_id: options.vaultId, phase: "canonicalize_registry" },
      });
      const seen = new Set<string>();
      registry = data.topics.flatMap((topic) => {
        const title = topic.title.trim();
        if (title.length === 0) return [];
        return [
          {
            slug: slugifyRegistry(title, seen),
            title,
            description: topic.description.trim(),
            linkTargetTitles: topic.link_targets,
          } satisfies RegistryTopic,
        ];
      });
      yield* options.putCache(options.vaultId, "canonicalize_registry", registryCacheKey, {
        topics: registry,
      });
    }
    if (registry.length === 0) return [];

    const assignTemplate = yield* loadPrompt(
      options.storage,
      options.vaultId,
      "canonicalize_assign",
    );
    const assignPromptHash = promptContentHash(assignTemplate);
    yield* recordPrompt(options.db, assignPromptHash, assignTemplate);
    const registryBlock = registry
      .map((topic) => `- ${topic.slug} — ${topic.title}: ${topic.description}`)
      .join("\n");
    const registrySignature = contentHash(
      ...registry.map((topic) => `${topic.slug}|${topic.title}|${topic.description}`),
    );
    const slugs = new Set(registry.map((topic) => topic.slug));
    const marker = "{subtopics_block}";
    const splitTemplate = assignTemplate.split(marker);
    if (splitTemplate.length !== 2) {
      return yield* new MalformedPromptTemplate({
        message: `canonicalize_assign prompt must contain exactly one ${marker} placeholder`,
      });
    }
    const [head, tail] = splitTemplate as [string, string];
    const prefix = head.replace("{registry_block}", registryBlock);
    const assignment = new Map<Uuid, string>();
    for (let offset = 0; offset < ordered.length; offset += 30) {
      const batch = ordered.slice(offset, offset + 30);
      const cacheKey = canonicalizeAssignCacheKey({
        batch,
        registrySignature,
        promptHash: assignPromptHash,
        model: options.config.reduceModel,
      });
      const cached = yield* options.getCache(options.vaultId, "canonicalize_assign", cacheKey);
      if (cached !== undefined) {
        for (const [localId, slug] of cached.assign) {
          assignment.set(localId, slug);
        }
        continue;
      }
      const subtopics = batch
        .map((topic, index) => `${index + 1}. ${topic.title} :: ${topic.description}`)
        .join("\n");
      const data = yield* options.jsonCall({
        vaultId: options.vaultId,
        runId: options.runId,
        phase: "canonicalize_assign",
        promptHash: assignPromptHash,
        model: options.config.reduceModel,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prefix, cache_control: { type: "ephemeral" } },
              { type: "text", text: subtopics + tail },
            ],
          },
        ],
        temperature: options.config.reduceTemperature,
        responseFormat: assignmentsResponseFormat,
        schema: AssignmentsResponse,
        maxParseRetries: 2,
        logFields: {
          vault_id: options.vaultId,
          phase: "canonicalize_assign",
          batch_offset: offset,
        },
      });
      const batchAssign = new Map<Uuid, string>();
      for (const item of data.assignments) {
        if (item.n >= 1 && item.n <= batch.length && slugs.has(item.slug)) {
          const localId = batch[item.n - 1]?.localTopicId;
          if (localId !== undefined) {
            assignment.set(localId, item.slug);
            batchAssign.set(localId, item.slug);
          }
        }
      }
      yield* options.putCache(options.vaultId, "canonicalize_assign", cacheKey, {
        assign: batchAssign,
      });
    }

    const titleToSlug = new Map(registry.map((topic) => [topic.title, topic.slug]));
    const members = new Map<string, Uuid[]>();
    for (const topic of ordered) {
      const slug = assignment.get(topic.localTopicId);
      if (slug === undefined) continue;
      const memberList = members.get(slug) ?? [];
      memberList.push(topic.localTopicId);
      members.set(slug, memberList);
    }
    return registry.flatMap((topic) => {
      const ids = members.get(topic.slug);
      if (ids === undefined || ids.length === 0) return [];
      const links: string[] = [];
      for (const title of topic.linkTargetTitles) {
        const slug = titleToSlug.get(title);
        if (slug !== undefined && slug !== topic.slug && !links.includes(slug)) links.push(slug);
      }
      return [
        {
          slug: topic.slug,
          title: topic.title,
          description: topic.description,
          mergedLocalTopicIds: ids.toSorted(),
          linkTargets: links,
        } satisfies CanonicalDraft,
      ];
    });
  });

const tagToIndex = (tag: string, prefix: string, upperBound: number) => {
  if (!tag.startsWith(prefix)) return undefined;
  const suffix = tag.slice(prefix.length);
  if (!/^\d+$/.test(suffix)) return undefined;
  const parsed = Number(suffix) - 1;
  return Number.isInteger(parsed) && parsed >= 0 && parsed < upperBound ? parsed : undefined;
};

const validateTopics = (
  options: AbstractOptions,
  inputCanonicals: readonly CanonicalDraft[],
  localTopics: readonly LocalTopic[],
) =>
  Effect.gen(function* () {
    if (inputCanonicals.length === 0) return [] as readonly ValidatedTopic[];
    const slugs = new Set(inputCanonicals.map((canonical) => canonical.slug));
    let canonicals = inputCanonicals.map((canonical) => ({
      ...canonical,
      linkTargets: canonical.linkTargets.filter(
        (target) => target !== canonical.slug && slugs.has(target),
      ),
    }));
    const existing = yield* options.db.query((d) =>
      d
        .select()
        .from(topics)
        .where(eq(topics.vaultId, options.vaultId))
        .orderBy(asc(topics.title)),
    );
    const active = existing.filter((topic) => topic.articleStatus !== "archived");
    const localById = new Map(localTopics.map((topic) => [topic.localTopicId, topic]));
    const subsumedByCanonical = canonicals.map((canonical) =>
      [
        ...new Set(
          canonical.mergedLocalTopicIds.flatMap(
            (localId) => localById.get(localId)?.subsumedIdeaIds ?? [],
          ),
        ),
      ].toSorted(),
    );
    const activeIds = active.map((topic) => topic.topicId);
    const membershipRows =
      activeIds.length === 0
        ? []
        : yield* options.db.query((d) =>
            d
              .select({ topicId: topicMembership.topicId, ideaId: topicMembership.ideaId })
              .from(topicMembership)
              .where(inArray(topicMembership.topicId, activeIds)),
          );
    const priorIdeaIds = new Map<Uuid, Uuid[]>();
    for (const row of membershipRows) {
      const list = priorIdeaIds.get(row.topicId) ?? [];
      list.push(row.ideaId);
      priorIdeaIds.set(row.topicId, list);
    }
    const resolution = resolveCompositionIdentity(
      active.map((topic) => ({
        topicId: topic.topicId,
        slug: topic.slug,
        ideaIds: priorIdeaIds.get(topic.topicId) ?? [],
      })),
      canonicals.map((canonical, index) => ({
        slug: canonical.slug,
        ideaIds: subsumedByCanonical[index] ?? [],
      })),
    );
    const residueIds = new Set(resolution.residue);
    yield* options.logger.info("composition_identity_resolved", {
      vault_id: options.vaultId,
      run_id: options.runId,
      prior_active: active.length,
      carried: resolution.carries.size,
      archived_mechanical: resolution.archived.size,
      residue: resolution.residue.length,
    });
    const collisions = new Map<string, number[]>();
    canonicals.forEach((canonical, index) => {
      const indexes = collisions.get(canonical.slug) ?? [];
      indexes.push(index);
      collisions.set(canonical.slug, indexes);
    });
    for (const [slug, indexes] of collisions) {
      if (indexes.length < 2) collisions.delete(slug);
    }
    const archiveCandidates = active.filter((topic) => residueIds.has(topic.topicId));
    const renames = new Map<number, string>();
    const supersessions = new Map<string, number | null>();
    if (collisions.size > 0 || archiveCandidates.length > 0) {
      const template = yield* loadPrompt(options.storage, options.vaultId, "cleanup");
      const promptHash = promptContentHash(template);
      yield* recordPrompt(options.db, promptHash, template);
      const canonicalBlock = canonicals
        .flatMap((canonical, index) => [
          `## c_${index + 1}`,
          `slug: ${canonical.slug}`,
          `title: ${canonical.title}`,
          `description: ${canonical.description}`,
          "",
        ])
        .join("\n");
      const collisionBlock =
        collisions.size === 0
          ? ""
          : [
              "## Slug collisions",
              "",
              ...[...collisions].map(
                ([slug, indexes]) =>
                  `- slug "${slug}" is claimed by: ${indexes.map((index) => `c_${index + 1}`).join(", ")}`,
              ),
              "",
            ].join("\n");
      const supersessionBlock =
        archiveCandidates.length === 0
          ? ""
          : [
              "## Archived candidates (previous-compile topics with no mechanically determined successor)",
              "",
              ...archiveCandidates.flatMap((topic, index) => [
                `## a_${index + 1}`,
                `slug: ${topic.slug}`,
                `title: ${topic.title}`,
                `description: ${topic.description}`,
                "",
              ]),
            ].join("\n");
      const data = yield* options.jsonCall({
        vaultId: options.vaultId,
        runId: options.runId,
        phase: "validate_cleanup",
        promptHash,
        model: options.config.reduceModel,
        messages: [
          {
            role: "user",
            content: template
              .replace("{canonical_block}", canonicalBlock)
              .replace("{collision_block}", collisionBlock)
              .replace("{supersession_block}", supersessionBlock),
          },
        ],
        temperature: options.config.reduceTemperature,
        responseFormat: cleanupResponseFormat,
        schema: CleanupResponse,
        logFields: { vault_id: options.vaultId, phase: "validate_cleanup" },
      });
      for (const rename of data.slug_renames ?? []) {
        const index = tagToIndex(rename.canonical_tag ?? "", "c_", canonicals.length);
        const newSlug = (rename.new_slug ?? "").trim().toLowerCase();
        if (index !== undefined && newSlug.length > 0) renames.set(index, newSlug);
      }
      const archivedByTag = new Map(
        archiveCandidates.map((topic, index) => [`a_${index + 1}`, topic.topicId]),
      );
      for (const entry of data.supersessions ?? []) {
        const archivedId = archivedByTag.get(entry.archived_tag ?? "");
        if (archivedId === undefined) continue;
        const successor = entry.successor_tag
          ? tagToIndex(entry.successor_tag, "c_", canonicals.length)
          : undefined;
        supersessions.set(archivedId, successor ?? null);
      }
    }
    canonicals = canonicals.map((canonical, index) => ({
      ...canonical,
      slug: renames.get(index) ?? canonical.slug,
    }));
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const canonical of canonicals) {
      if (seen.has(canonical.slug)) duplicates.push(canonical.slug);
      seen.add(canonical.slug);
    }
    if (duplicates.length > 0) {
      return yield* new MalformedLlmOutput({
        message: `validate: cleanup LLM did not resolve all slug collisions: [${duplicates.map((slug) => `'${slug}'`).join(", ")}]`,
      });
    }
    const existingBySlug = new Map(existing.map((topic) => [topic.slug, topic]));
    const disposed = new Set([
      ...resolution.archived.keys(),
      ...resolution.residue,
      ...resolution.carries.values(),
    ]);
    const validated: ValidatedTopic[] = [];
    for (const [index, canonical] of canonicals.entries()) {
      // Identity: composition carry first; the slug fallback only revives a
      // topic this run is not otherwise disposing of (archived resurrection).
      const carried = resolution.carries.get(index);
      const bySlug = existingBySlug.get(canonical.slug);
      const topicId =
        carried ??
        (bySlug !== undefined && !disposed.has(bySlug.topicId) ? bySlug.topicId : undefined) ??
        (yield* options.mintUuid7);
      validated.push({
        topicId,
        slug: canonical.slug,
        title: canonical.title,
        description: canonical.description,
        subsumedIdeaIds: subsumedByCanonical[index] ?? [],
        linkTargets: canonical.linkTargets,
      });
    }
    // Vacate moved slugs before the upserts so a carried topic's new slug
    // cannot collide with the row still holding it under the unique key.
    const existingById = new Map(existing.map((topic) => [topic.topicId, topic]));
    for (const topic of validated) {
      const previous = existingById.get(topic.topicId);
      if (previous === undefined || previous.slug === topic.slug) continue;
      yield* options.db.query((d) =>
        d
          .update(topics)
          .set({ slug: `~${topic.topicId}` })
          .where(eq(topics.topicId, topic.topicId)),
      );
    }
    const activeById = new Map(active.map((topic) => [topic.topicId, topic]));
    const successorId = (index: number | null) =>
      index === null ? null : (validated[index]?.topicId ?? null);
    const transitions: ArchiveTransition[] = [];
    for (const [topicId, index] of resolution.archived) {
      const candidate = activeById.get(topicId);
      if (candidate === undefined) continue;
      transitions.push({
        topicId,
        slug: candidate.slug,
        supersededBy: successorId(index),
      });
    }
    for (const candidate of archiveCandidates) {
      const successorIndex = supersessions.get(candidate.topicId);
      transitions.push({
        topicId: candidate.topicId,
        slug: candidate.slug,
        supersededBy: successorIndex === undefined ? null : successorId(successorIndex),
      });
    }
    yield* options.archiveTransitions(options.vaultId, transitions);
    for (const topic of validated) {
      yield* options.db.query((d) =>
        d
          .insert(topics)
          .values({
            topicId: topic.topicId,
            vaultId: options.vaultId,
            slug: topic.slug,
            title: topic.title,
            description: topic.description,
            compiledFromHash: contentHash(
              topic.title,
              topic.description,
              ...topic.subsumedIdeaIds.toSorted(),
            ),
          })
          .onConflictDoUpdate({
            target: topics.topicId,
            set: {
              slug: topic.slug,
              title: topic.title,
              description: topic.description,
              compiledFromHash: contentHash(
                topic.title,
                topic.description,
                ...topic.subsumedIdeaIds.toSorted(),
              ),
              updatedAt: sql`now()`,
            },
          }),
      );
    }
    return validated;
  });

type RenderOptions = {
  readonly vaultId: Uuid;
  readonly runId: Uuid;
  readonly validated: readonly ValidatedTopic[];
  readonly config: AppConfigShape;
  readonly db: DatabaseService;
  readonly storage: StorageService;
  readonly pipeline: PipelineService;
  readonly logger: Logger;
  readonly jsonCall: JsonCall;
  readonly getCache: CacheGetter;
  readonly putCache: CachePutter;
  readonly materializeArticle: (
    vaultId: Uuid,
    runId: Uuid,
    topic: ValidatedTopic,
    output: { readonly body: string; readonly tags: readonly string[] },
  ) => Effect.Effect<void, unknown>;
  readonly rebuildWiki: (vaultId: Uuid, runId: Uuid) => Effect.Effect<number, unknown>;
};

type RenderIdea = {
  readonly ideaId: Uuid;
  readonly documentId: Uuid;
  readonly kind: string;
  readonly label: string;
  readonly description: string;
  readonly anchors: readonly Anchor[];
};

type NumberedAnchor = {
  readonly number: number;
  readonly anchor: Anchor;
  readonly idea: RenderIdea;
  readonly document: SourceRow | undefined;
};

const runRender = (options: RenderOptions) =>
  Effect.gen(function* () {
    if (options.validated.length === 0) return;
    yield* options.pipeline.updateProgress(
      options.runId,
      "render",
      "progress",
      progressSteps(RENDER_STEP_LABELS, "plan_articles", {
        counts: { plan_articles: [0, options.validated.length] },
      }),
    );
    const promptTemplate = yield* loadPrompt(options.storage, options.vaultId, "render");
    const promptHash = promptContentHash(promptTemplate);
    yield* recordPrompt(options.db, promptHash, promptTemplate);
    const toRender: ValidatedTopic[] = [];
    let materialized = 0;
    for (const [index, topic] of options.validated.entries()) {
      const cacheKey = renderCacheKey({
        topic,
        promptHash,
        model: options.config.renderModel,
      });
      const cached = yield* options.getCache(options.vaultId, "render", cacheKey);
      if (cached === undefined) {
        toRender.push(topic);
      } else {
        yield* options.materializeArticle(options.vaultId, options.runId, topic, cached);
        materialized += 1;
      }
      yield* options.pipeline.updateProgress(
        options.runId,
        "render",
        "progress",
        progressSteps(RENDER_STEP_LABELS, "plan_articles", {
          counts: { plan_articles: [index + 1, options.validated.length] },
        }),
      );
    }

    if (toRender.length > 0) {
      yield* options.pipeline.updateProgress(
        options.runId,
        "render",
        "progress",
        progressSteps(RENDER_STEP_LABELS, "write_articles", {
          completed: new Set(["plan_articles"]),
          counts: {
            plan_articles: [options.validated.length, options.validated.length],
            write_articles: [0, toRender.length],
          },
        }),
      );
      const neededIds = [...new Set(toRender.flatMap((topic) => topic.subsumedIdeaIds))];
      const ideaRows =
        neededIds.length === 0
          ? []
          : yield* options.db.query((d) =>
              d
                .select({
                  ideaId: ideas.ideaId,
                  documentId: ideas.documentId,
                  kind: ideas.kind,
                  label: ideas.label,
                  description: ideas.description,
                })
                .from(ideas)
                .where(inArray(ideas.ideaId, neededIds)),
            );
      const anchorRows =
        neededIds.length === 0
          ? []
          : yield* options.db.query((d) =>
              d
                .select()
                .from(anchors)
                .where(inArray(anchors.ideaId, neededIds))
                .orderBy(asc(anchors.ideaId), asc(anchors.position)),
            );
      const anchorsByIdea = new Map<string, Anchor[]>();
      for (const anchor of anchorRows) {
        const group = anchorsByIdea.get(anchor.ideaId) ?? [];
        group.push({
          claim: anchor.claim,
          quote: anchor.quote,
          chunkIndex: anchor.chunkIndex,
        });
        anchorsByIdea.set(anchor.ideaId, group);
      }
      const ideasById = new Map<string, RenderIdea>(
        ideaRows.map((idea) => [
          idea.ideaId,
          { ...idea, anchors: anchorsByIdea.get(idea.ideaId) ?? [] },
        ]),
      );
      const documents = yield* options.db.query((d) =>
        d.select().from(sourceDocuments).where(eq(sourceDocuments.vaultId, options.vaultId)),
      );
      const documentsById = new Map(documents.map((document) => [document.id, document]));
      const topicsBySlug = new Map(options.validated.map((topic) => [topic.slug, topic]));
      let done = 0;
      const rendered = yield* Effect.forEach(
        toRender,
        (topic) =>
          Effect.gen(function* () {
            const numbered = numberedAnchors(topic, ideasById, documentsById);
            const ideaBlock = renderIdeaBlock(topic, numbered, ideasById, documentsById);
            const linkBlock = topic.linkTargets
              .flatMap((slug) => {
                const target = topicsBySlug.get(slug);
                return target === undefined
                  ? []
                  : [`- [${target.title}](wiki/${slug}.md) — ${target.description}`];
              })
              .join("\n");
            const prompt = promptTemplate
              .replace("{title}", topic.title)
              .replace("{description}", topic.description)
              .replace("{idea_block}", ideaBlock)
              .replace("{link_targets_block}", linkBlock || "(none)");
            const result = yield* Effect.result(
              options.jsonCall({
                vaultId: options.vaultId,
                runId: options.runId,
                phase: "render",
                promptHash,
                model: options.config.renderModel,
                messages: [{ role: "user", content: prompt }],
                temperature: options.config.renderTemperature,
                responseFormat: articleResponseFormat,
                schema: RenderResponse,
                logFields: { topic_id: topic.topicId, topic_slug: topic.slug },
              }),
            );
            if (result._tag === "Failure") {
              const details = errorDetails(result.failure);
              yield* options.logger.warn("topic_failed", {
                vault_id: options.vaultId,
                run_id: options.runId,
                topic_id: topic.topicId,
                topic_slug: topic.slug,
                error_type: details.errorType,
                error: details.message.slice(0, 300),
              });
              return false;
            }
            const processed = yield* Effect.result(
              Effect.gen(function* () {
                const tags = yield* Schema.decodeUnknownEffect(RenderTags)(
                  result.success.tags,
                ).pipe(
                  Effect.mapError(
                    (error) =>
                      new MalformedLlmOutput({
                        message: "invalid render output",
                        issue: error.issue,
                      }),
                  ),
                );
                const body = yield* postprocessBody(result.success.body, numbered);
                return { body, tags };
              }),
            );
            if (processed._tag === "Failure") {
              const details = errorDetails(processed.failure);
              yield* options.logger.warn("body_invalid", {
                vault_id: options.vaultId,
                run_id: options.runId,
                topic_id: topic.topicId,
                topic_slug: topic.slug,
                error_type: details.errorType,
                error: details.message.slice(0, 300),
              });
              return false;
            }
            const finalOutput = processed.success;
            yield* options.putCache(
              options.vaultId,
              "render",
              renderCacheKey({
                topic,
                promptHash,
                model: options.config.renderModel,
              }),
              finalOutput,
            );
            yield* options.materializeArticle(options.vaultId, options.runId, topic, finalOutput);
            return true;
          }).pipe(
            Effect.tap(() =>
              Effect.gen(function* () {
                done += 1;
                yield* options.pipeline.updateProgress(
                  options.runId,
                  "render",
                  "progress",
                  progressSteps(RENDER_STEP_LABELS, "write_articles", {
                    completed: new Set(["plan_articles"]),
                    counts: {
                      plan_articles: [options.validated.length, options.validated.length],
                      write_articles: [done, toRender.length],
                    },
                  }),
                );
              }),
            ),
          ),
        { concurrency: options.config.compileWriteConcurrency },
      );
      if (!rendered.includes(true) && materialized === 0) {
        yield* options.pipeline.updateProgress(
          options.runId,
          "render",
          "completed",
          progressSteps(RENDER_STEP_LABELS, "index_articles", {
            completed: new Set(Object.keys(RENDER_STEP_LABELS)),
            counts: {
              plan_articles: [options.validated.length, options.validated.length],
              write_articles: [done, toRender.length],
            },
          }),
        );
        return;
      }
    }
    if (materialized > 0 || toRender.length > 0) {
      yield* options.pipeline.updateProgress(
        options.runId,
        "render",
        "progress",
        progressSteps(RENDER_STEP_LABELS, "index_articles", {
          completed: new Set(["plan_articles", "write_articles"]),
          counts: {
            plan_articles: [options.validated.length, options.validated.length],
            write_articles: [toRender.length, toRender.length],
          },
        }),
      );
      yield* options.rebuildWiki(options.vaultId, options.runId);
    }
    yield* options.pipeline.updateProgress(
      options.runId,
      "render",
      "completed",
      progressSteps(RENDER_STEP_LABELS, "index_articles", {
        completed: new Set(Object.keys(RENDER_STEP_LABELS)),
        counts: {
          plan_articles: [options.validated.length, options.validated.length],
          write_articles: [toRender.length, toRender.length],
        },
      }),
    );
  });

const sourceLabel = (document: SourceRow) => {
  const title = document.title?.trim() || "Untitled";
  const date = document.publishedDate?.trim() ?? "";
  return date.length > 0 ? `${title} (${date})` : title;
};

const numberedAnchors = (
  topic: ValidatedTopic,
  ideasById: ReadonlyMap<string, RenderIdea>,
  documentsById: ReadonlyMap<string, SourceRow>,
) => {
  const result: NumberedAnchor[] = [];
  let counter = 0;
  for (const ideaId of topic.subsumedIdeaIds) {
    const idea = ideasById.get(ideaId);
    if (idea === undefined) continue;
    const document = documentsById.get(idea.documentId);
    for (const anchor of idea.anchors) {
      counter += 1;
      result.push({ number: counter, anchor, idea, document });
    }
  }
  return result;
};

const renderIdeaBlock = (
  topic: ValidatedTopic,
  numbered: readonly NumberedAnchor[],
  ideasById: ReadonlyMap<string, RenderIdea>,
  documentsById: ReadonlyMap<string, SourceRow>,
) => {
  const anchorsByIdea = new Map<string, NumberedAnchor[]>();
  for (const anchor of numbered) {
    const group = anchorsByIdea.get(anchor.idea.ideaId) ?? [];
    group.push(anchor);
    anchorsByIdea.set(anchor.idea.ideaId, group);
  }
  const lines: string[] = [];
  for (const ideaId of topic.subsumedIdeaIds) {
    const idea = ideasById.get(ideaId);
    if (idea === undefined) continue;
    const document = documentsById.get(idea.documentId);
    lines.push(`### Idea: [${idea.kind}] ${idea.label}`);
    lines.push(`Description: ${idea.description}`);
    lines.push(
      document === undefined
        ? `Source: (unresolved document ${idea.documentId})`
        : `Source: [${sourceLabel(document)}](${document.filePath})`,
    );
    for (const anchor of anchorsByIdea.get(ideaId) ?? []) {
      lines.push(`[^${anchor.number}] claim: ${anchor.anchor.claim}`);
    }
    lines.push("");
  }
  return lines.join("\n");
};

const postprocessBody = (rawBody: string, numbered: readonly NumberedAnchor[]) =>
  Effect.gen(function* () {
    const body = rawBody.trim();
    if (body.length === 0 || body.startsWith("---") || !/^# /m.test(body)) {
      return yield* new MalformedLlmOutput({ message: "invalid render body" });
    }
    const sources = new Map(numbered.map((anchor) => [anchor.number, anchor]));
    const used: number[] = [];
    for (const match of body.matchAll(/\[\^(\d+)\]/g)) {
      const number = Number.parseInt(match[1] ?? "", 10);
      if (sources.has(number) && !used.includes(number)) used.push(number);
    }
    const remap = new Map(used.map((number, index) => [number, index + 1]));
    const renumbered = body
      .replace(/\[\^(\d+)\]/g, (_match, raw: string) => {
        const display = remap.get(Number.parseInt(raw, 10));
        return display === undefined ? "" : `[^${display}]`;
      })
      .replace(/ {2,}/g, " ");
    if (used.length === 0) return `${renumbered.trimEnd()}\n`;
    const lines = ["", "---", ""];
    used.forEach((original, index) => {
      const source = sources.get(original);
      if (source === undefined) return;
      const link =
        source.document === undefined
          ? "unknown source"
          : `[${sourceLabel(source.document)}](${source.document.filePath}${
              source.anchor.chunkIndex === null ? "" : `#^p${source.anchor.chunkIndex}`
            })`;
      lines.push(`[^${index + 1}]: ${link} — "${source.anchor.quote.trim()}"`);
    });
    return `${renumbered.trimEnd()}\n${lines.join("\n")}\n`;
  });
