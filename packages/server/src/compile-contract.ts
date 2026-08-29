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

export type TopicComposition = {
  readonly topicId: string;
  readonly slug: string;
  readonly ideaIds: readonly string[];
};

export type CompositionResolution = {
  /** canonical index → prior topicId whose identity it carries forward */
  readonly carries: ReadonlyMap<number, string>;
  /** prior topicId → successor canonical index (null = retire), resolved mechanically */
  readonly archived: ReadonlyMap<string, number | null>;
  /** prior topicIds left for LLM adjudication */
  readonly residue: readonly string[];
};

// Containment thresholds: a prior topic tracks into the canonical holding a
// clear majority of its surviving ideas; it carries identity only when it also
// makes up most of that canonical (otherwise it was absorbed and archives with
// a successor pointer). Priors with too few surviving ideas cannot be matched
// on composition and fall through to the LLM.
export const COMPOSITION_MIN_SURVIVING = 3;
export const COMPOSITION_TRACK_SHARE = 0.5;
export const COMPOSITION_TRACK_MARGIN = 0.15;
export const COMPOSITION_CARRY_REVERSE = 0.5;

export const resolveCompositionIdentity = (
  priorTopics: readonly TopicComposition[],
  canonicals: readonly { readonly slug: string; readonly ideaIds: readonly string[] }[],
): CompositionResolution => {
  const canonicalSets = canonicals.map((canonical) => new Set(canonical.ideaIds));
  const universe = new Set(canonicals.flatMap((canonical) => canonical.ideaIds));
  const slugCounts = new Map<string, number>();
  for (const canonical of canonicals) {
    slugCounts.set(canonical.slug, (slugCounts.get(canonical.slug) ?? 0) + 1);
  }
  const canonicalBySlug = new Map<string, number>();
  canonicals.forEach((canonical, index) => {
    if (slugCounts.get(canonical.slug) === 1) canonicalBySlug.set(canonical.slug, index);
  });

  const carries = new Map<number, string>();
  const archived = new Map<string, number | null>();
  const residue: string[] = [];
  const byId = (left: TopicComposition, right: TopicComposition) =>
    left.topicId < right.topicId ? -1 : 1;

  const remaining: TopicComposition[] = [];
  for (const prior of priorTopics.toSorted(byId)) {
    const index = canonicalBySlug.get(prior.slug);
    if (index !== undefined && !carries.has(index)) carries.set(index, prior.topicId);
    else remaining.push(prior);
  }

  type CarryCandidate = { readonly prior: TopicComposition; readonly index: number; readonly overlap: number };
  const carryCandidates: CarryCandidate[] = [];
  for (const prior of remaining) {
    const surviving = prior.ideaIds.filter((ideaId) => universe.has(ideaId));
    if (surviving.length < COMPOSITION_MIN_SURVIVING) {
      residue.push(prior.topicId);
      continue;
    }
    let best = -1;
    let bestOverlap = 0;
    let secondOverlap = 0;
    canonicalSets.forEach((ideaSet, index) => {
      let overlap = 0;
      for (const ideaId of surviving) if (ideaSet.has(ideaId)) overlap += 1;
      if (overlap > bestOverlap) {
        secondOverlap = bestOverlap;
        bestOverlap = overlap;
        best = index;
      } else if (overlap > secondOverlap) {
        secondOverlap = overlap;
      }
    });
    const share = bestOverlap / surviving.length;
    const margin = (bestOverlap - secondOverlap) / surviving.length;
    if (best === -1 || share < COMPOSITION_TRACK_SHARE || margin < COMPOSITION_TRACK_MARGIN) {
      residue.push(prior.topicId);
      continue;
    }
    const reverse = bestOverlap / canonicalSets[best].size;
    if (reverse >= COMPOSITION_CARRY_REVERSE && !carries.has(best)) {
      carryCandidates.push({ prior, index: best, overlap: bestOverlap });
    } else {
      archived.set(prior.topicId, best);
    }
  }

  carryCandidates.sort(
    (left, right) => right.overlap - left.overlap || byId(left.prior, right.prior),
  );
  for (const candidate of carryCandidates) {
    if (carries.has(candidate.index)) archived.set(candidate.prior.topicId, candidate.index);
    else carries.set(candidate.index, candidate.prior.topicId);
  }
  return { carries, archived, residue };
};
