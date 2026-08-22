import { readFile } from "node:fs/promises";

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
import type { Uuid } from "@great-minds/domain";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { Effect, Fiber, Semaphore } from "effect";
import { parse as parseYaml } from "yaml";

import type { AppConfigShape } from "./config.ts";
import {
  ABSTRACT_STEP_LABELS,
  canonicalizeAssignCacheKey,
  canonicalizeRegistryCacheKey,
  EXTRACT_STEP_LABELS,
  partitionCacheKey,
  RENDER_STEP_LABELS,
  renderCacheKey,
  resolveCompositionIdentity,
  synthesizeCacheKey,
  type ArchiveTransition,
  type ValidatedTopic,
} from "./compile-contract.ts";
import { contentHash, promptContentHash } from "./crypto.ts";
import type { EmbeddingsService } from "./embeddings.ts";
import { errorDetails as describeError } from "./error-details.ts";
import type { LanguageModel, LlmMessage, ModelCompletion } from "./llm.ts";
import { recordPrompt } from "./llm-costs.ts";
import type { StructuredLogger } from "./logging.ts";
import { markdownParagraphs, parseFrontmatter, serializeFrontmatter } from "./markdown.ts";
import type { PipelineRunsService } from "./pipeline-runs.ts";
import { progressSteps } from "./pipeline-runs.ts";
import { formatUuid7, type RandomBytesService } from "./random.ts";
import { type ContentStorage, StorageFileMissing, vaultOwner } from "./storage.ts";
import type { ClockService } from "./clock.ts";

type DatabaseService = Database["Service"];
type StorageService = ContentStorage["Service"];
type PipelineService = PipelineRunsService["Service"];
type ModelService = LanguageModel["Service"];
type EmbeddingService = EmbeddingsService["Service"];
type RandomService = RandomBytesService["Service"];
type Clock = ClockService["Service"];
type Logger = StructuredLogger["Service"];

class MalformedLlmOutput extends Error {
  readonly _tag = "MalformedLlmOutput";

  constructor(message: string) {
    super(message);
    this.name = this._tag;
  }
}

class MalformedCompileCache extends Error {
  readonly _tag = "MalformedCompileCache";

  constructor(message: string) {
    super(message);
    this.name = this._tag;
  }
}

class MalformedPromptTemplate extends Error {
  readonly _tag = "MalformedPromptTemplate";

  constructor(message: string) {
    super(message);
    this.name = this._tag;
  }
}

class EmbeddingBatchFailed extends Error {
  readonly _tag = "EmbeddingBatchFailed";
  readonly cause: unknown;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = this._tag;
    this.cause = cause;
  }
}

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

const isTimeoutError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  if ("cause" in error && error.cause !== error) return isTimeoutError(error.cause);
  return "name" in error && error.name === "TimeoutError";
};

type EnrichedField = {
  readonly name: string;
  readonly type: "string" | "list";
  readonly description: string;
};

type CompileVaultConfig = {
  readonly thematicHint: string;
  readonly kinds: readonly string[];
  readonly enrichedFields: readonly EnrichedField[];
};

type Anchor = {
  readonly claim: string;
  readonly quote: string;
  readonly chunkIndex: number | null;
};

type Idea = {
  readonly ideaId: string;
  readonly documentId: string;
  readonly kind: string;
  readonly label: string;
  readonly description: string;
  readonly anchors: readonly Anchor[];
};

type SourceCard = {
  readonly documentId: string;
  readonly title: string;
  readonly precis: string;
  readonly author: string | null;
  readonly publishedDate: string | null;
  readonly genre: string | null;
  readonly tags: readonly string[];
  readonly derivedExtras: Record<string, unknown>;
  readonly ideas: readonly Idea[];
};

export type LocalTopic = {
  readonly localTopicId: string;
  readonly chunkIdx: number;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly subsumedIdeaIds: readonly string[];
};

type RegistryTopic = {
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly linkTargetTitles: readonly string[];
};

type CanonicalDraft = {
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly mergedLocalTopicIds: readonly string[];
  readonly linkTargets: readonly string[];
};

type SourceRow = typeof sourceDocuments.$inferSelect;

const defaultVaultConfig: CompileVaultConfig = {
  thematicHint: "",
  kinds: ["person", "event", "organization", "concept"],
  enrichedFields: [],
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const strings = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const nullableString = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value : null;

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const vectorLiteral = (embedding: readonly number[]) => `[${embedding.join(",")}]`;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const extractResponseFormat = (config: CompileVaultConfig) => {
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

const jsonObjectResponseFormat = { type: "json_object" } as const;

const promptUrl = (name: string) => new URL(`./default_prompts/${name}.md`, import.meta.url);

const loadPrompt = (storage: StorageService, vaultId: Uuid, name: string) =>
  Effect.gen(function* () {
    const override = yield* Effect.result(
      storage.readText(vaultOwner(vaultId), `prompts/${name}.md`),
    );
    if (override._tag === "Success") return override.success.trim();
    if (!(override.failure instanceof StorageFileMissing))
      return yield* Effect.fail(override.failure);
    return yield* Effect.tryPromise(() => readFile(promptUrl(name), "utf8")).pipe(
      Effect.orDie,
      Effect.map((value) => value.trim()),
    );
  });

const loadVaultConfig = (storage: StorageService, vaultId: Uuid) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(storage.readText(vaultOwner(vaultId), "config.yaml"));
    if (result._tag === "Failure") {
      if (result.failure instanceof StorageFileMissing) return defaultVaultConfig;
      return yield* Effect.fail(result.failure);
    }
    const decoded = asRecord(parseYaml(result.success));
    if (decoded === undefined) return defaultVaultConfig;
    const configuredKinds = strings(decoded.kinds);
    const metadata = asRecord(decoded.metadata) ?? {};
    const enrichedFields: EnrichedField[] = [];
    for (const [name, raw] of Object.entries(metadata)) {
      const spec = asRecord(raw);
      if (spec === undefined) continue;
      const type = spec.type === "list" ? "list" : "string";
      enrichedFields.push({
        name,
        type,
        description: typeof spec.description === "string" ? spec.description : "",
      });
    }
    return {
      thematicHint:
        typeof decoded.thematic_hint === "string" && decoded.thematic_hint.length > 0
          ? decoded.thematic_hint
          : defaultVaultConfig.thematicHint,
      kinds: configuredKinds.length > 0 ? configuredKinds : defaultVaultConfig.kinds,
      enrichedFields,
    } satisfies CompileVaultConfig;
  });

const formatEnrichedFields = (fields: readonly EnrichedField[]) =>
  fields
    .map((field) => {
      const kindHint = field.type === "list" ? "array of strings" : "string or null";
      const description = field.description.trim() || `${field.name} value`;
      return `    - \`${field.name}\` (${kindHint}): ${description}`;
    })
    .join("\n");

const stripJsonFencing = (raw: string) =>
  raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");

export const decodeCompileJsonCompletion = (model: string, completion: ModelCompletion) => {
  if (completion.finishReason === "length") {
    throw new Error(
      `${model} output hit the token limit (finish_reason=length) and was truncated — the request is too large for a single completion`,
    );
  }
  return JSON.parse(stripJsonFencing(completion.text.trim())) as unknown;
};

const parseSourceCard = (value: unknown): SourceCard | undefined => {
  const source = asRecord(value);
  if (source === undefined) return undefined;
  const rawIdeas = Array.isArray(source.ideas) ? source.ideas : undefined;
  const rawTags = source.tags === undefined ? [] : source.tags;
  const rawExtras = source.derived_extras === undefined ? {} : source.derived_extras;
  if (
    typeof source.document_id !== "string" ||
    !UUID_PATTERN.test(source.document_id) ||
    typeof source.title !== "string" ||
    typeof source.precis !== "string" ||
    rawIdeas === undefined ||
    !Array.isArray(rawTags) ||
    strings(rawTags).length !== rawTags.length ||
    asRecord(rawExtras) === undefined ||
    ![source.author, source.published_date, source.genre].every(
      (field) => field === undefined || field === null || typeof field === "string",
    )
  ) {
    return undefined;
  }
  const parsedIdeas: Idea[] = [];
  for (const raw of rawIdeas) {
    const idea = asRecord(raw);
    const rawAnchors = idea?.anchors === undefined ? [] : idea.anchors;
    if (
      idea === undefined ||
      typeof idea.idea_id !== "string" ||
      !UUID_PATTERN.test(idea.idea_id) ||
      typeof idea.document_id !== "string" ||
      !UUID_PATTERN.test(idea.document_id) ||
      typeof idea.kind !== "string" ||
      typeof idea.label !== "string" ||
      typeof idea.description !== "string" ||
      !Array.isArray(rawAnchors)
    ) {
      return undefined;
    }
    const parsedAnchors: Anchor[] = [];
    for (const rawAnchor of rawAnchors) {
      const anchor = asRecord(rawAnchor);
      if (
        anchor === undefined ||
        typeof anchor.claim !== "string" ||
        typeof anchor.quote !== "string" ||
        (anchor.chunk_index !== undefined &&
          anchor.chunk_index !== null &&
          !Number.isInteger(anchor.chunk_index))
      ) {
        return undefined;
      }
      parsedAnchors.push({
        claim: anchor.claim,
        quote: anchor.quote,
        chunkIndex: Number.isInteger(anchor.chunk_index) ? (anchor.chunk_index as number) : null,
      });
    }
    parsedIdeas.push({
      ideaId: idea.idea_id,
      documentId: idea.document_id,
      kind: idea.kind,
      label: idea.label,
      description: idea.description,
      anchors: parsedAnchors,
    });
  }
  return {
    documentId: source.document_id,
    title: source.title as string,
    precis: source.precis as string,
    author: nullableString(source.author),
    publishedDate: nullableString(source.published_date),
    genre: nullableString(source.genre),
    tags: strings(rawTags),
    derivedExtras: asRecord(rawExtras) as Record<string, unknown>,
    ideas: parsedIdeas,
  };
};

const dumpSourceCard = (card: SourceCard) => ({
  document_id: card.documentId,
  title: card.title,
  precis: card.precis,
  author: card.author,
  published_date: card.publishedDate,
  genre: card.genre,
  tags: [...card.tags],
  derived_extras: card.derivedExtras,
  ideas: card.ideas.map((idea) => ({
    idea_id: idea.ideaId,
    document_id: idea.documentId,
    kind: idea.kind,
    label: idea.label,
    description: idea.description,
    anchors: idea.anchors.map((anchor) => ({
      claim: anchor.claim,
      quote: anchor.quote,
      chunk_index: anchor.chunkIndex,
    })),
  })),
});

const parseLocalTopics = (value: unknown): readonly LocalTopic[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const out: LocalTopic[] = [];
  for (const raw of value) {
    const topic = asRecord(raw);
    if (
      topic === undefined ||
      typeof topic.local_topic_id !== "string" ||
      !Number.isInteger(topic.chunk_idx) ||
      typeof topic.slug !== "string" ||
      typeof topic.title !== "string" ||
      typeof topic.description !== "string"
    ) {
      return undefined;
    }
    const ids = strings(topic.subsumed_idea_ids);
    if (!Array.isArray(topic.subsumed_idea_ids) || ids.length !== topic.subsumed_idea_ids.length) {
      return undefined;
    }
    out.push({
      localTopicId: topic.local_topic_id,
      chunkIdx: topic.chunk_idx as number,
      slug: topic.slug,
      title: topic.title,
      description: topic.description,
      subsumedIdeaIds: ids,
    });
  }
  return out;
};

const dumpLocalTopic = (topic: LocalTopic) => ({
  local_topic_id: topic.localTopicId,
  chunk_idx: topic.chunkIdx,
  slug: topic.slug,
  title: topic.title,
  description: topic.description,
  subsumed_idea_ids: [...topic.subsumedIdeaIds],
});

type CompileLlmCoreOptions = {
  readonly config: AppConfigShape;
  readonly db: DatabaseService;
  readonly embeddings: EmbeddingService;
  readonly languageModel: ModelService;
  readonly pipeline: PipelineService;
  readonly storage: StorageService;
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
  const { config, db, embeddings, languageModel, pipeline, storage, randomBytes, clock, logger } =
    options;
  let lastMintTimestamp = -1;

  const mintUuid7 = Effect.gen(function* () {
    const [now, bytes] = yield* Effect.all([clock.now, randomBytes.bytes(16)]);
    const timestamp = Math.max(now.getTime(), lastMintTimestamp + 1);
    lastMintTimestamp = timestamp;
    return formatUuid7(timestamp, bytes);
  });

  const jsonCall = (input: {
    readonly vaultId: Uuid;
    readonly runId: Uuid;
    readonly phase: string;
    readonly promptHash: string;
    readonly model: string;
    readonly messages: readonly LlmMessage[];
    readonly temperature: number;
    readonly responseFormat: Record<string, unknown>;
    readonly maxParseRetries?: number;
    readonly logFields?: Record<string, string | number>;
  }) =>
    Effect.gen(function* () {
      const totalAttempts = (input.maxParseRetries ?? 1) + 1;
      let lastError: unknown;
      for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
        const completion = yield* Effect.tryPromise({
          try: () =>
            languageModel.complete({
              model: input.model,
              messages: input.messages,
              temperature: input.temperature,
              responseFormat: input.responseFormat,
              requestProfile: "compile",
            }),
          catch: (error) => error,
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
          return yield* Effect.try({
            try: () => decodeCompileJsonCompletion(input.model, completion),
            catch: (error) => error,
          });
        }
        const decoded = yield* Effect.result(
          Effect.try({
            try: () => decodeCompileJsonCompletion(input.model, completion),
            catch: (error) => error,
          }),
        );
        if (decoded._tag === "Success") return decoded.success;
        lastError = decoded.failure;
        if (attempt === totalAttempts) return yield* Effect.fail(decoded.failure);
        const details = errorDetails(decoded.failure);
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
      return yield* Effect.fail(lastError);
    });

  const putCache = (vaultId: Uuid, phase: string, cacheKey: string, value: unknown) =>
    db.query((d) => d
      .insert(compileCacheEntries)
      .values({ vaultId, phase, cacheKey, value })
      .onConflictDoNothing());

  const getCache = (vaultId: Uuid, phase: string, cacheKey: string) =>
    db.query((d) => d
      .select({ value: compileCacheEntries.value })
      .from(compileCacheEntries)
      .where(
        and(
          eq(compileCacheEntries.vaultId, vaultId),
          eq(compileCacheEntries.phase, phase),
          eq(compileCacheEntries.cacheKey, cacheKey),
        ),
      )
      .limit(1))
      .pipe(Effect.map((rows) => rows[0]?.value));

  const extract = (vaultId: Uuid, runId: Uuid) =>
    Effect.gen(function* () {
      const vaultConfig = yield* loadVaultConfig(storage, vaultId);
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

      const outcomes: (
        | { readonly kind: "failed" }
        | { readonly kind: "cached"; readonly documentId: Uuid; readonly card: SourceCard }
        | {
            readonly kind: "fresh";
            readonly documentId: Uuid;
            readonly card: SourceCard;
            readonly cacheKey: string;
          }
      )[] = [];

      let documentsCompleted = 0;
      const extractSemaphore = yield* Semaphore.make(config.compileEnrichConcurrency);
      const extractFibers = [];
      for (const document of documents) {
        extractFibers.push(
          yield* Effect.gen(function* () {
            const result = yield* Effect.result(
              Effect.gen(function* () {
                const cacheKey = contentHash(
                  `doc=${document.id}`,
                  document.bodyHash,
                  `prompt=${promptHash}`,
                  `model=${config.extractModel}`,
                );
                const cachedValue = yield* getCache(vaultId, "extract", cacheKey);
                if (cachedValue !== undefined) {
                  const cached = asRecord(cachedValue);
                  const cachedCard = parseSourceCard(cached?.source_card);
                  if (cachedCard === undefined) {
                    return yield* Effect.fail(
                      new MalformedCompileCache(`extract cache row ${cacheKey} is malformed`),
                    );
                  }
                  return {
                    kind: "cached",
                    documentId: document.id as Uuid,
                    card: cachedCard,
                  } as const;
                }
                const content = yield* storage.readText(vaultOwner(vaultId), document.filePath);
                const body = parseFrontmatter(content).body;
                const data = yield* extractSemaphore.withPermit(
                  jsonCall({
                    vaultId,
                    runId,
                    phase: "extract",
                    promptHash,
                    model: config.extractModel,
                    messages: [
                      { role: "user", content: renderedTemplate.replace("{doc_content}", body) },
                    ],
                    temperature: 0.2,
                    responseFormat,
                    logFields: { document_id: document.id, path: document.filePath },
                  }),
                );
                const card = yield* validateExtractOutput(
                  data,
                  document.id,
                  vaultConfig.kinds,
                  body,
                  mintUuid7,
                );
                return {
                  kind: "fresh",
                  documentId: document.id as Uuid,
                  card,
                  cacheKey,
                } as const;
              }),
            );
            if (result._tag === "Success") return result.success;
            const details = errorDetails(result.failure);
            yield* logger.warn("doc_failed", {
              vault_id: vaultId,
              run_id: runId,
              document_id: document.id,
              path: document.filePath,
              error_type: details.errorType,
              error: details.message.slice(0, 300),
            });
            return { kind: "failed" } as const;
          }).pipe(
            Effect.tap((outcome) =>
              Effect.gen(function* () {
                outcomes.push(outcome);
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
            ),
            Effect.forkChild({ startImmediately: true }),
          ),
        );
      }
      yield* Effect.forEach(extractFibers, Fiber.join, { discard: true });

      const existing = new Set(
        (yield* db.query((d) => d
          .select({ id: ideas.ideaId })
          .from(ideas)
          .where(eq(ideas.vaultId, vaultId)))).map((row) => row.id),
      );
      const fresh = outcomes.filter(
        (outcome): outcome is Extract<(typeof outcomes)[number], { kind: "fresh" }> =>
          outcome.kind === "fresh",
      );
      for (const outcome of fresh) {
        yield* putCache(vaultId, "extract", outcome.cacheKey, {
          source_card: dumpSourceCard(outcome.card),
        });
      }
      const embeddingInputs = outcomes.flatMap((outcome) => {
        if (outcome.kind === "failed") return [];
        return outcome.card.ideas
          .filter((idea) => outcome.kind === "fresh" || !existing.has(idea.ideaId as Uuid))
          .map((idea) => ({ documentId: outcome.documentId, idea }));
      });

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

      if (fresh.length > 0) {
        yield* db.query((d) => d
          .delete(ideas)
          .where(
            inArray(
              ideas.documentId,
              fresh.map((outcome) => outcome.documentId),
            ),
          ));
      }

      let embeddedCount = 0;
      for (let offset = 0; offset < embeddingInputs.length; offset += 50) {
        const batch = embeddingInputs.slice(offset, offset + 50);
        const embedded = yield* Effect.result(
          Effect.tryPromise({
            try: () =>
              embeddings.embed(
                batch.map(({ idea }) => `${idea.label}. ${idea.description}`.trim()),
              ),
            catch: (error) => new EmbeddingBatchFailed(error),
          }),
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
        const ideaRows = paired.map(({ input: { documentId, idea }, embedding }) => ({
          ideaId: idea.ideaId as Uuid,
          vaultId,
          documentId,
          kind: idea.kind,
          label: idea.label,
          description: idea.description,
          embedding: sql`${vectorLiteral(embedding)}::vector`,
          embeddingModel: config.embeddingModel,
        }));
        if (ideaRows.length === 0) continue;
        yield* db.query((d) =>
          d
            .insert(ideas)
            .values(ideaRows)
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
            ),
        );
        yield* db.query((d) => d
          .delete(anchors)
          .where(
            inArray(
              anchors.ideaId,
              ideaRows.map((row) => row.ideaId),
            ),
          ));
        const anchorRows = paired.flatMap(({ input: { idea } }) =>
          idea.anchors.map((anchor, position) => ({
            ideaId: idea.ideaId as Uuid,
            position,
            claim: anchor.claim,
            quote: anchor.quote,
            chunkIndex: anchor.chunkIndex,
          })),
        );
        if (anchorRows.length > 0) yield* db.query((d) => d.insert(anchors).values(anchorRows));
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

      const documentsById = new Map(documents.map((document) => [document.id, document]));
      for (const outcome of fresh) {
        const document = documentsById.get(outcome.documentId);
        if (document === undefined) throw new Error(`document ${outcome.documentId} disappeared`);
        const existingContent = yield* storage.readText(vaultOwner(vaultId), document.filePath);
        const body = parseFrontmatter(existingContent).body;
        const frontmatter: Record<string, unknown> = {
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
          title: outcome.card.title,
          precis: outcome.card.precis,
          author: outcome.card.author,
          date: outcome.card.publishedDate,
          genre: outcome.card.genre,
          tags: outcome.card.tags.length > 0 ? [...outcome.card.tags] : null,
          ...outcome.card.derivedExtras,
        };
        const nextContent = serializeFrontmatter(
          Object.fromEntries(
            Object.entries(frontmatter).filter(
              (_entry): _entry is [string, Exclude<unknown, null | undefined>] =>
                _entry[1] !== null && _entry[1] !== undefined,
            ),
          ),
          body,
        );
        yield* storage.writeText(vaultOwner(vaultId), document.filePath, nextContent);
        yield* db.query((d) => d
          .update(sourceDocuments)
          .set({
            title: outcome.card.title,
            precis: outcome.card.precis,
            author: outcome.card.author,
            publishedDate: outcome.card.publishedDate,
            genre: outcome.card.genre,
            tags: [...outcome.card.tags],
            derivedExtras: outcome.card.derivedExtras,
            updatedAt: sql`now()`,
          })
          .where(eq(sourceDocuments.id, document.id)));
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

const pythonTruthy = (value: unknown) => {
  if (value === null || value === undefined || value === false || value === 0 || value === "") {
    return false;
  }
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
};

const coercedString = (value: unknown, field: string) => {
  if (!pythonTruthy(value)) return Effect.succeed("");
  return typeof value === "string"
    ? Effect.succeed(value)
    : Effect.fail(new MalformedLlmOutput(`invalid source card ${field}`));
};

const coercedNullableString = (value: unknown, field: string) => {
  if (!pythonTruthy(value)) return Effect.succeed(null);
  return typeof value === "string"
    ? Effect.succeed(value)
    : Effect.fail(new MalformedLlmOutput(`invalid source card ${field}`));
};

const PYTHON_WHITESPACE = new RegExp(
  String.raw`[\t\n\v\f\r\u001c-\u001f \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+`,
  "g",
);

export const normalizePythonWhitespace = (value: string) =>
  value.replace(PYTHON_WHITESPACE, " ").replace(/^ | $/g, "");

const validateExtractOutput = (
  data: unknown,
  documentId: string,
  allowedKinds: readonly string[],
  body: string,
  mintUuid7: Effect.Effect<string>,
) =>
  Effect.gen(function* () {
    const record = asRecord(data);
    if (record === undefined)
      return yield* Effect.fail(new MalformedLlmOutput("invalid source card"));
    const ideasValue = pythonTruthy(record.ideas) ? record.ideas : [];
    if (!Array.isArray(ideasValue)) {
      return yield* Effect.fail(new MalformedLlmOutput("invalid source card ideas"));
    }
    const title = yield* coercedString(record.title, "title");
    const precis = yield* coercedString(record.precis, "precis");
    const author = yield* coercedNullableString(record.author, "author");
    const publishedDate = yield* coercedNullableString(record.published_date, "published_date");
    const genre = yield* coercedNullableString(record.genre, "genre");
    const tagsValue = pythonTruthy(record.tags) ? record.tags : [];
    if (!Array.isArray(tagsValue) || strings(tagsValue).length !== tagsValue.length) {
      return yield* Effect.fail(new MalformedLlmOutput("invalid source card tags"));
    }
    const extrasValue = pythonTruthy(record.derived_extras) ? record.derived_extras : {};
    const derivedExtras = asRecord(extrasValue);
    if (derivedExtras === undefined) {
      return yield* Effect.fail(new MalformedLlmOutput("invalid source card derived_extras"));
    }
    const paragraphBodies = markdownParagraphs(body).map((paragraph) => ({
      index: paragraph.index,
      body: normalizePythonWhitespace(paragraph.body),
    }));
    const parsedIdeas: Idea[] = [];
    for (const raw of ideasValue) {
      const idea = asRecord(raw);
      if (idea === undefined) return yield* Effect.fail(new MalformedLlmOutput("invalid idea"));
      const anchorsValue = pythonTruthy(idea.anchors) ? idea.anchors : [];
      if (!Array.isArray(anchorsValue)) {
        return yield* Effect.fail(new MalformedLlmOutput("invalid idea anchors"));
      }
      const rawKind = pythonTruthy(idea.kind) ? idea.kind : "other";
      if (typeof rawKind === "object") {
        return yield* Effect.fail(new MalformedLlmOutput("invalid idea kind"));
      }
      const kind =
        typeof rawKind === "string" && (allowedKinds.includes(rawKind) || rawKind === "other")
          ? rawKind
          : "other";
      const label = yield* coercedString(idea.label, "idea label");
      const description = yield* coercedString(idea.description, "idea description");
      const parsedAnchors: Anchor[] = [];
      for (const rawAnchor of anchorsValue) {
        const anchor = asRecord(rawAnchor);
        if (anchor === undefined) {
          return yield* Effect.fail(new MalformedLlmOutput("invalid anchor"));
        }
        const claim = yield* coercedString(anchor.claim, "anchor claim");
        const quote = yield* coercedString(anchor.quote, "anchor quote");
        const normalizedQuote = normalizePythonWhitespace(quote);
        parsedAnchors.push({
          claim,
          quote,
          chunkIndex:
            normalizedQuote.length === 0
              ? null
              : (paragraphBodies.find((paragraph) => paragraph.body.includes(normalizedQuote))
                  ?.index ?? null),
        });
      }
      parsedIdeas.push({
        ideaId: yield* mintUuid7,
        documentId,
        kind,
        label,
        description,
        anchors: parsedAnchors,
      });
    }
    return {
      documentId,
      title,
      precis,
      author,
      publishedDate,
      genre,
      tags: strings(tagsValue),
      derivedExtras,
      ideas: parsedIdeas,
    } satisfies SourceCard;
  });

type JsonCall = (input: {
  readonly vaultId: Uuid;
  readonly runId: Uuid;
  readonly phase: string;
  readonly promptHash: string;
  readonly model: string;
  readonly messages: readonly LlmMessage[];
  readonly temperature: number;
  readonly responseFormat: Record<string, unknown>;
  readonly maxParseRetries?: number;
  readonly logFields?: Record<string, string | number>;
}) => Effect.Effect<unknown, unknown>;

type CacheGetter = (
  vaultId: Uuid,
  phase: string,
  cacheKey: string,
) => Effect.Effect<unknown, unknown>;
type CachePutter = (
  vaultId: Uuid,
  phase: string,
  cacheKey: string,
  value: unknown,
) => Effect.Effect<unknown, unknown>;

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
  readonly mintUuid7: Effect.Effect<string>;
  readonly archiveTransitions: (
    vaultId: Uuid,
    transitions: readonly ArchiveTransition[],
  ) => Effect.Effect<void, unknown>;
};

type IdeaContext = {
  readonly ideaId: string;
  readonly documentId: string;
  readonly kind: string;
  readonly label: string;
  readonly description: string;
  readonly embedding: readonly number[];
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
        embedding: ideas.embedding,
      })
      .from(ideas)
      .where(eq(ideas.vaultId, vaultId))
      .orderBy(asc(ideas.ideaId)));
    const docs = yield* db.query((d) => d
      .select()
      .from(sourceDocuments)
      .where(eq(sourceDocuments.vaultId, vaultId)));
    const docsById = new Map(docs.map((document) => [document.id, document]));
    const contexts: IdeaContext[] = rows.flatMap((row) => {
      const document = docsById.get(row.documentId);
      return document === undefined || row.embedding === null
        ? []
        : [
            {
              ideaId: row.ideaId,
              documentId: row.documentId,
              kind: row.kind,
              label: row.label,
              description: row.description,
              embedding: row.embedding,
              document,
            },
          ];
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
    const vaultConfig = yield* loadVaultConfig(storage, vaultId);
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

const partitionIdeas = (options: AbstractOptions, contexts: readonly IdeaContext[]) =>
  Effect.gen(function* () {
    if (contexts.length === 0) return [] as readonly (readonly string[])[];
    const ids = contexts.map((idea) => idea.ideaId).toSorted();
    const cacheKey = partitionCacheKey(ids, options.config.compilePartitionTargetTokens);
    const cached = asRecord(yield* options.getCache(options.vaultId, "partition", cacheKey));
    const cachedChunks = cached?.chunks;
    if (Array.isArray(cachedChunks)) {
      const chunks = cachedChunks.map(strings);
      if (cachedChunks.every(Array.isArray)) return chunks;
    }
    const tokens = contexts.map(estimateTokens);
    const totalTokens = tokens.reduce((sum, value) => sum + value, 0);
    const k = Math.min(
      contexts.length,
      Math.max(1, Math.ceil(totalTokens / options.config.compilePartitionTargetTokens)),
    );
    const labels =
      k === 1
        ? contexts.map(() => 0)
        : seededMiniBatchLabels(
            contexts.map((x) => x.embedding),
            k,
          );
    let chunks = groupLabels(labels);
    chunks = rebalanceChunks(
      chunks,
      tokens,
      contexts.map((idea) => idea.embedding),
      Math.trunc(
        options.config.compilePartitionTargetTokens * options.config.compilePartitionMinFactor,
      ),
      Math.trunc(
        options.config.compilePartitionTargetTokens * options.config.compilePartitionMaxFactor,
      ),
    );
    const result = chunks.map((chunk) => chunk.map((row) => contexts[row]?.ideaId ?? ""));
    yield* options.putCache(options.vaultId, "partition", cacheKey, {
      chunks: result,
      k_initial: k,
      total_tokens: totalTokens,
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

const squaredDistance = (left: readonly number[], right: readonly number[]) => {
  let sum = 0;
  for (let i = 0; i < left.length; i += 1) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    sum += delta * delta;
  }
  return sum;
};

const chooseCenters = (matrix: readonly (readonly number[])[], k: number) => {
  const rng = new Mt19937(42);
  const centers: number[][] = [];
  const first = Math.min(matrix.length - 1, Math.floor(rng.random() * matrix.length));
  centers.push([...(matrix[first] ?? [])]);
  let closest = matrix.map((row) => squaredDistance(row, centers[0] ?? []));
  for (let centerIndex = 1; centerIndex < k; centerIndex += 1) {
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
    centers.push([...(matrix[bestCandidate] ?? [])]);
    closest = bestDistances;
  }
  return centers;
};

const kmeansLabels = (matrix: readonly (readonly number[])[], k: number) => {
  let centers = chooseCenters(matrix, k);
  let labels = matrix.map(() => 0);
  for (let iteration = 0; iteration < 100; iteration += 1) {
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
};

const seededMiniBatchLabels = (matrix: readonly (readonly number[])[], k: number) => {
  const permutation = new Pcg64Seed42();
  const batchSize = 1024;
  let centers: number[][] | undefined;
  let counts: number[] = [];
  let previous: number[][] | undefined;
  for (let epoch = 0; epoch < 10; epoch += 1) {
    const order = permutation.permutation(matrix.length);
    for (let start = 0; start < order.length; start += batchSize) {
      const batch = order
        .slice(start, start + batchSize)
        .map((row) => (matrix[row] ?? []).map(Math.fround));
      if (centers === undefined) {
        if (batch.length < k) throw new Error("k-means batch has fewer rows than clusters");
        centers = chooseCenters(batch, k).map((center) => center.map(Math.fround));
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
  return matrix.map((row) => {
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
};

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

const meanVector = (chunk: readonly number[], matrix: readonly (readonly number[])[]) => {
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
  matrix: readonly (readonly number[])[],
  maxTokens: number,
): number[][] => {
  if (chunkTokens(chunk, tokens) <= maxTokens || chunk.length < 2) return [[...chunk]];
  const ordered = [...chunk].toSorted((left, right) => left - right);
  const labels = kmeansLabels(
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
    ...splitChunk(first, tokens, matrix, maxTokens),
    ...splitChunk(second, tokens, matrix, maxTokens),
  ];
};

const normalize = (vector: readonly number[]) => {
  const norm = Math.hypot(...vector);
  return norm === 0 ? vector.map(() => 0) : vector.map((value) => value / norm);
};

const rebalanceChunks = (
  initial: readonly (readonly number[])[],
  tokens: readonly number[],
  matrix: readonly (readonly number[])[],
  minTokens: number,
  maxTokens: number,
) => {
  let chunks = initial.flatMap((chunk) => splitChunk(chunk, tokens, matrix, maxTokens));
  while (chunks.length > 1) {
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
};

const synthesizeTopics = (
  options: AbstractOptions,
  contexts: readonly IdeaContext[],
  chunks: readonly (readonly string[])[],
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
    const localTopics: LocalTopic[] = [];
    let chunksCompleted = 0;
    const synthesizeSemaphore = yield* Semaphore.make(options.config.compileEnrichConcurrency);
    const synthesizeFibers = [];
    for (const [chunkIdx, chunk] of chunks.entries()) {
      synthesizeFibers.push(
        yield* Effect.gen(function* () {
          const cacheKey = synthesizeCacheKey({
            ideaIds: chunk,
            promptHash,
            model: options.config.mapModel,
          });
          const cached = asRecord(yield* options.getCache(options.vaultId, "synthesize", cacheKey));
          const cachedTopics = parseLocalTopics(cached?.local_topics);
          if (cachedTopics !== undefined) return cachedTopics;
          const present = chunk.flatMap((ideaId) => {
            const idea = contextsById.get(ideaId);
            return idea === undefined ? [] : [idea];
          });
          if (present.length === 0) return [];
          const { block, tags } = synthesisIdeaBlock(present);
          const result = yield* Effect.result(
            synthesizeSemaphore.withPermit(
              options.jsonCall({
                vaultId: options.vaultId,
                runId: options.runId,
                phase: "synthesize",
                promptHash: synthesizePromptHash,
                model: options.config.mapModel,
                messages: [
                  { role: "user", content: promptTemplate.replace("{idea_block}", block) },
                ],
                temperature: 0.3,
                responseFormat: jsonObjectResponseFormat,
                logFields: { chunk_idx: chunkIdx },
              }),
            ),
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
            withPermit: (effect) => synthesizeSemaphore.withPermit(effect),
          });
          yield* options.putCache(options.vaultId, "synthesize", cacheKey, {
            local_topics: resolved.map(dumpLocalTopic),
          });
          return resolved;
        }).pipe(
          Effect.tap((topics) =>
            Effect.gen(function* () {
              localTopics.push(...topics);
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
          Effect.forkChild({ startImmediately: true }),
        ),
      );
    }
    yield* Effect.forEach(synthesizeFibers, Fiber.join, { discard: true });
    return localTopics;
  });

const synthesisIdeaBlock = (ideasInChunk: readonly IdeaContext[]) => {
  const byDocument = new Map<string, IdeaContext[]>();
  for (const idea of ideasInChunk) {
    const group = byDocument.get(idea.documentId) ?? [];
    group.push(idea);
    byDocument.set(idea.documentId, group);
  }
  const lines: string[] = [];
  const tags = new Map<string, string>();
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
  data: unknown,
  chunkIdx: number,
  tags: ReadonlyMap<string, string>,
  mintUuid7: Effect.Effect<string>,
) =>
  Effect.gen(function* () {
    const record = asRecord(data);
    const rawTopics = Array.isArray(record?.topics) ? record.topics : [];
    const out: LocalTopic[] = [];
    for (const raw of rawTopics) {
      const topic = asRecord(raw);
      if (topic === undefined) continue;
      const slug = normalizeSlug(typeof topic.slug === "string" ? topic.slug : "");
      const title = typeof topic.title === "string" ? topic.title.trim() : "";
      const description = typeof topic.description === "string" ? topic.description.trim() : "";
      const ids = [
        ...new Set(
          strings(topic.subsumed_idea_ids).flatMap((tag) => {
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
  const residues = new Map<number, Set<string>>();
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
    residues.get(index) ?? originalSets[index] ?? new Set<string>();
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
  readonly tags: ReadonlyMap<string, string>;
  readonly contexts: readonly IdeaContext[];
  readonly revisePrompt: string;
  readonly revisePromptHash: string;
  readonly decomposePrompt: string;
  readonly decomposePromptHash: string;
  readonly withPermit: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
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
        input.withPermit(
          options.jsonCall({
            vaultId: options.vaultId,
            runId: options.runId,
            phase: "synthesize_revise",
            promptHash: input.revisePromptHash,
            model: options.config.mapModel,
            messages: [{ role: "user", content }],
            temperature: 0.3,
            responseFormat: jsonObjectResponseFormat,
            logFields: { chunk_idx: input.chunkIdx, phase: "synthesize_revise" },
          }),
        ),
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
        input.withPermit(
          options.jsonCall({
            vaultId: options.vaultId,
            runId: options.runId,
            phase: "synthesize_decompose",
            promptHash: input.decomposePromptHash,
            model: options.config.mapModel,
            messages: [{ role: "user", content }],
            temperature: 0.3,
            responseFormat: jsonObjectResponseFormat,
            logFields: { chunk_idx: input.chunkIdx, phase: "synthesize_decompose" },
          }),
        ),
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

const parseRegistryTopics = (value: unknown): readonly RegistryTopic[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const result: RegistryTopic[] = [];
  for (const raw of value) {
    const topic = asRecord(raw);
    if (
      topic === undefined ||
      typeof topic.slug !== "string" ||
      typeof topic.title !== "string" ||
      typeof topic.description !== "string" ||
      !Array.isArray(topic.link_target_titles) ||
      strings(topic.link_target_titles).length !== topic.link_target_titles.length
    ) {
      return undefined;
    }
    result.push({
      slug: topic.slug,
      title: topic.title,
      description: topic.description,
      linkTargetTitles: strings(topic.link_target_titles),
    });
  }
  return result;
};

const dumpRegistryTopic = (topic: RegistryTopic) => ({
  slug: topic.slug,
  title: topic.title,
  description: topic.description,
  link_target_titles: [...topic.linkTargetTitles],
});

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
    const cachedRegistryValue = yield* options.getCache(
      options.vaultId,
      "canonicalize_registry",
      registryCacheKey,
    );
    let registry: readonly RegistryTopic[];
    if (cachedRegistryValue !== undefined) {
      const cachedRegistry = asRecord(cachedRegistryValue);
      const parsed = parseRegistryTopics(cachedRegistry?.topics);
      if (parsed === undefined) {
        return yield* Effect.fail(
          new MalformedCompileCache(
            `canonicalize_registry cache row ${registryCacheKey} is malformed`,
          ),
        );
      }
      registry = parsed;
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
        temperature: 0.2,
        responseFormat: registryResponseFormat,
        logFields: { vault_id: options.vaultId, phase: "canonicalize_registry" },
      });
      const seen = new Set<string>();
      const dataRecord = asRecord(data);
      registry = (Array.isArray(dataRecord?.topics) ? dataRecord.topics : []).flatMap((raw) => {
        const topic = asRecord(raw);
        const title = typeof topic?.title === "string" ? topic.title.trim() : "";
        if (title.length === 0) return [];
        return [
          {
            slug: slugifyRegistry(title, seen),
            title,
            description: typeof topic?.description === "string" ? topic.description.trim() : "",
            linkTargetTitles: strings(topic?.link_targets),
          } satisfies RegistryTopic,
        ];
      });
      yield* options.putCache(options.vaultId, "canonicalize_registry", registryCacheKey, {
        topics: registry.map(dumpRegistryTopic),
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
      return yield* Effect.fail(
        new MalformedPromptTemplate(
          `canonicalize_assign prompt must contain exactly one ${marker} placeholder`,
        ),
      );
    }
    const [head, tail] = splitTemplate as [string, string];
    const prefix = head.replace("{registry_block}", registryBlock);
    const assignment = new Map<string, string>();
    for (let offset = 0; offset < ordered.length; offset += 30) {
      const batch = ordered.slice(offset, offset + 30);
      const cacheKey = canonicalizeAssignCacheKey({
        batch,
        registrySignature,
        promptHash: assignPromptHash,
        model: options.config.reduceModel,
      });
      const cachedValue = yield* options.getCache(options.vaultId, "canonicalize_assign", cacheKey);
      if (cachedValue !== undefined) {
        const cached = asRecord(cachedValue);
        const cachedAssign = asRecord(cached?.assign);
        if (
          cachedAssign === undefined ||
          Object.entries(cachedAssign).some(
            ([localId, slug]) => !UUID_PATTERN.test(localId) || typeof slug !== "string",
          )
        ) {
          return yield* Effect.fail(
            new MalformedCompileCache(`canonicalize_assign cache row ${cacheKey} is malformed`),
          );
        }
        for (const [localId, slug] of Object.entries(cachedAssign)) {
          assignment.set(localId, slug as string);
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
        temperature: 0.1,
        responseFormat: assignmentsResponseFormat,
        maxParseRetries: 2,
        logFields: {
          vault_id: options.vaultId,
          phase: "canonicalize_assign",
          batch_offset: offset,
        },
      });
      const batchAssign: Record<string, string> = {};
      const rawAssignments = Array.isArray(asRecord(data)?.assignments)
        ? (asRecord(data)?.assignments as unknown[])
        : [];
      for (const raw of rawAssignments) {
        const item = asRecord(raw);
        const n = item?.n;
        const slug = item?.slug;
        if (
          Number.isInteger(n) &&
          (n as number) >= 1 &&
          (n as number) <= batch.length &&
          typeof slug === "string" &&
          slugs.has(slug)
        ) {
          const localId = batch[(n as number) - 1]?.localTopicId;
          if (localId !== undefined) {
            assignment.set(localId, slug);
            batchAssign[localId] = slug;
          }
        }
      }
      yield* options.putCache(options.vaultId, "canonicalize_assign", cacheKey, {
        assign: batchAssign,
      });
    }

    const titleToSlug = new Map(registry.map((topic) => [topic.title, topic.slug]));
    const members = new Map<string, string[]>();
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

const tagToIndex = (tag: unknown, prefix: string, upperBound: number) => {
  if (typeof tag !== "string" || !tag.startsWith(prefix)) return undefined;
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
    const activeIds = active.map((topic) => topic.topicId as Uuid);
    const membershipRows =
      activeIds.length === 0
        ? []
        : yield* options.db.query((d) =>
            d
              .select({ topicId: topicMembership.topicId, ideaId: topicMembership.ideaId })
              .from(topicMembership)
              .where(inArray(topicMembership.topicId, activeIds)),
          );
    const priorIdeaIds = new Map<string, string[]>();
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
        temperature: 0.1,
        responseFormat: jsonObjectResponseFormat,
        logFields: { vault_id: options.vaultId, phase: "validate_cleanup" },
      });
      const record = asRecord(data);
      if (record === undefined) {
        return yield* Effect.fail(new MalformedLlmOutput("cleanup response is not an object"));
      }
      const renamesValue = pythonTruthy(record.slug_renames) ? record.slug_renames : [];
      if (!Array.isArray(renamesValue)) {
        return yield* Effect.fail(new MalformedLlmOutput("cleanup slug_renames is not an array"));
      }
      const rawRenames = renamesValue;
      for (const raw of rawRenames) {
        const rename = asRecord(raw);
        if (rename === undefined) {
          return yield* Effect.fail(new MalformedLlmOutput("cleanup slug rename is not an object"));
        }
        if (pythonTruthy(rename.canonical_tag) && typeof rename.canonical_tag !== "string") {
          return yield* Effect.fail(
            new MalformedLlmOutput("cleanup canonical_tag is not a string"),
          );
        }
        if (pythonTruthy(rename.new_slug) && typeof rename.new_slug !== "string") {
          return yield* Effect.fail(new MalformedLlmOutput("cleanup new_slug is not a string"));
        }
        const index = tagToIndex(rename?.canonical_tag, "c_", canonicals.length);
        const newSlug =
          typeof rename?.new_slug === "string" ? rename.new_slug.trim().toLowerCase() : "";
        if (index !== undefined && newSlug.length > 0) renames.set(index, newSlug);
      }
      const archivedByTag = new Map(
        archiveCandidates.map((topic, index) => [`a_${index + 1}`, topic.topicId]),
      );
      const supersessionsValue = pythonTruthy(record.supersessions) ? record.supersessions : [];
      if (!Array.isArray(supersessionsValue)) {
        return yield* Effect.fail(new MalformedLlmOutput("cleanup supersessions is not an array"));
      }
      const rawSupersessions = supersessionsValue;
      for (const raw of rawSupersessions) {
        const entry = asRecord(raw);
        if (entry === undefined) {
          return yield* Effect.fail(
            new MalformedLlmOutput("cleanup supersession is not an object"),
          );
        }
        if (pythonTruthy(entry.archived_tag) && typeof entry.archived_tag !== "string") {
          return yield* Effect.fail(new MalformedLlmOutput("cleanup archived_tag is not a string"));
        }
        if (pythonTruthy(entry.successor_tag) && typeof entry.successor_tag !== "string") {
          return yield* Effect.fail(
            new MalformedLlmOutput("cleanup successor_tag is not a string"),
          );
        }
        const archivedId = archivedByTag.get(
          typeof entry?.archived_tag === "string" ? entry.archived_tag : "",
        );
        if (archivedId === undefined) continue;
        const successor = entry?.successor_tag
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
      return yield* Effect.fail(
        new MalformedLlmOutput(
          `validate: cleanup LLM did not resolve all slug collisions: [${duplicates.map((slug) => `'${slug}'`).join(", ")}]`,
        ),
      );
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
          .where(eq(topics.topicId, topic.topicId as Uuid)),
      );
    }
    const activeById = new Map(active.map((topic) => [topic.topicId, topic]));
    const successorId = (index: number | null) =>
      index === null ? null : ((validated[index]?.topicId as Uuid | undefined) ?? null);
    const transitions: ArchiveTransition[] = [];
    for (const [topicId, index] of resolution.archived) {
      const candidate = activeById.get(topicId);
      if (candidate === undefined) continue;
      transitions.push({
        topicId: topicId as Uuid,
        slug: candidate.slug,
        supersededBy: successorId(index),
      });
    }
    for (const candidate of archiveCandidates) {
      const successorIndex = supersessions.get(candidate.topicId);
      transitions.push({
        topicId: candidate.topicId as Uuid,
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
            topicId: topic.topicId as Uuid,
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
  readonly ideaId: string;
  readonly documentId: string;
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
    const existingWiki = new Set(
      (yield* options.storage.listMarkdown(vaultOwner(options.vaultId), "wiki")).map(
        (file) => file.path,
      ),
    );
    const toRender: ValidatedTopic[] = [];
    let materialized = 0;
    for (const [index, topic] of options.validated.entries()) {
      const cacheKey = renderCacheKey({
        topic,
        promptHash,
        model: options.config.renderModel,
      });
      const cached = parseRenderOutput(
        yield* options.getCache(options.vaultId, "render", cacheKey),
      );
      if (cached === undefined) {
        toRender.push(topic);
      } else if (!existingWiki.has(`wiki/${topic.slug}.md`)) {
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
                .where(
                  inArray(
                    ideas.ideaId,
                    neededIds.map((id) => id as Uuid),
                  ),
                ),
            );
      const anchorRows =
        neededIds.length === 0
          ? []
          : yield* options.db.query((d) =>
              d
                .select()
                .from(anchors)
                .where(
                  inArray(
                    anchors.ideaId,
                    neededIds.map((id) => id as Uuid),
                  ),
                )
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
      let rendered = 0;
      const renderSemaphore = yield* Semaphore.make(options.config.compileWriteConcurrency);
      const renderFibers = [];
      for (const topic of toRender) {
        renderFibers.push(
          yield* Effect.gen(function* () {
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
              renderSemaphore.withPermit(
                options.jsonCall({
                  vaultId: options.vaultId,
                  runId: options.runId,
                  phase: "render",
                  promptHash,
                  model: options.config.renderModel,
                  messages: [{ role: "user", content: prompt }],
                  temperature: 0.3,
                  responseFormat: jsonObjectResponseFormat,
                  logFields: { topic_id: topic.topicId, topic_slug: topic.slug },
                }),
              ),
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
                const output = parseRenderOutput(result.success);
                if (output === undefined) {
                  return yield* Effect.fail(new MalformedLlmOutput("invalid render output"));
                }
                const body = postprocessBody(output.body, numbered);
                if (body === undefined) {
                  return yield* Effect.fail(new MalformedLlmOutput("invalid render body"));
                }
                return { body, tags: output.tags } as const;
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
            yield* options.materializeArticle(options.vaultId, options.runId, topic, finalOutput);
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
            return true;
          }).pipe(
            Effect.tap((success) =>
              Effect.gen(function* () {
                if (success) rendered += 1;
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
            Effect.forkChild({ startImmediately: true }),
          ),
        );
      }
      yield* Effect.forEach(renderFibers, Fiber.join, { discard: true });
      if (rendered === 0 && materialized === 0) {
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

const parseRenderOutput = (value: unknown) => {
  const record = asRecord(value);
  if (record === undefined || typeof record.body !== "string" || !Array.isArray(record.tags)) {
    return undefined;
  }
  const rawTags = strings(record.tags);
  if (rawTags.length !== record.tags.length) return undefined;
  const tags: string[] = [];
  for (const raw of rawTags) {
    const tag = raw.trim().toLowerCase().replaceAll(" ", "-");
    if (tag.length === 0) return undefined;
    if (!tags.includes(tag)) tags.push(tag);
  }
  return { body: record.body, tags } as const;
};

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

const postprocessBody = (rawBody: string, numbered: readonly NumberedAnchor[]) => {
  const body = rawBody.trim();
  if (body.length === 0 || body.startsWith("---") || !/^# /m.test(body)) return undefined;
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
};
