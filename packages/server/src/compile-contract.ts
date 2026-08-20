import type { Uuid } from "@great-minds/domain";
import { Schema } from "effect";

import { contentHash } from "./crypto.ts";
import { errorDetails } from "./error-details.ts";

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

export const phaseFailure = (phase: CompilePhase, cause: unknown) => {
  if (cause instanceof CompilePhaseNotPorted || cause instanceof CompilePhaseFailed) return cause;
  const error = errorDetails(cause);
  return new CompilePhaseFailed({ phase, ...error });
};
