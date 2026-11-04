import { Uuid } from "@great-minds/domain";
import { Schema } from "effect";

import { contentHash } from "./crypto.ts";
import { errorDetails } from "./error-details.ts";

export const INGEST_STEP_LABELS = { index_sources: "Indexing for search" } as const;
export const EXTRACT_STEP_LABELS = {
  extract_cards: "Extracting source cards",
  embed_ideas: "Embedding ideas",
} as const;
export const THEMES_ABSTRACT_STEP_LABELS = {
  propose_topics: "Finding each source's topics",
  group_topics: "Grouping topics into themes",
  build_articles: "Building articles from themes",
} as const;
export const THEMES_RENDER_STEP_LABELS = {
  write_articles: "Writing articles",
  link_articles: "Linking articles",
  index_articles: "Indexing articles",
} as const;
export const DERIVE_STEP_LABELS = { find_related: "Connecting related topics" } as const;
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

export class CompilePhaseNotPorted extends Schema.TaggedError<CompilePhaseNotPorted>()(
  "CompilePhaseNotPorted",
  { phase: CompilePhase, message: Schema.String },
) {}

export class CompilePhaseFailed extends Schema.TaggedError<CompilePhaseFailed>()(
  "CompilePhaseFailed",
  { phase: CompilePhase, errorType: Schema.String, message: Schema.String },
) {}

export const CompileWorkflowError = Schema.Union([CompilePhaseNotPorted, CompilePhaseFailed]);

export const ValidatedTopic = Schema.Struct({
  topicId: Uuid,
  slug: Schema.String,
  title: Schema.String,
  description: Schema.String,
  subsumedIdeaIds: Schema.Array(Uuid),
});
export type ValidatedTopic = typeof ValidatedTopic.Type;

export type ArchiveTransition = {
  readonly topicId: Uuid;
  readonly slug: string;
  readonly supersededBy: Uuid | null;
};

export const topicContentHash = (topic: ValidatedTopic) =>
  contentHash(topic.title, topic.description, ...topic.subsumedIdeaIds.toSorted());

const PHASE_FAILURE_MESSAGE_LIMIT = 500;

export const phaseFailure = (phase: CompilePhase, cause: unknown) => {
  if (cause instanceof CompilePhaseNotPorted || cause instanceof CompilePhaseFailed) return cause;
  const error = errorDetails(cause);
  return new CompilePhaseFailed({
    phase,
    errorType: error.errorType,
    message:
      error.message.length > PHASE_FAILURE_MESSAGE_LIMIT
        ? `${error.message.slice(0, PHASE_FAILURE_MESSAGE_LIMIT)}…`
        : error.message,
  });
};
