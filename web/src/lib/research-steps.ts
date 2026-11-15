import type { ChunkRange, Citation } from "@great-minds/domain";

import type { Exchange, SourceRef } from "#lib/types.ts";

export interface ReadStep {
  readonly kind: "read";
  readonly source: SourceRef;
  readonly pending: boolean;
  readonly read: ReadonlySet<number>;
  readonly fetching: ReadonlySet<number>;
  readonly hits: ReadonlySet<number>;
  readonly cited: ReadonlySet<number>;
}

export interface LookupStep {
  readonly kind: "search" | "query" | "links";
  readonly source: SourceRef;
  readonly pending: boolean;
}

export type ResearchStep = ReadStep | LookupStep;

export interface ResearchRound {
  readonly key: string;
  readonly note: string | null;
  readonly steps: readonly ResearchStep[];
}

const sections = (ranges: readonly ChunkRange[] | undefined) =>
  (ranges ?? []).flatMap((range) =>
    Array.from({ length: range.end - range.start + 1 }, (_, index) => range.start + index),
  );

const citedSections = (citations: readonly Citation[]) => {
  const cited = new Map<string, Set<number>>();
  for (const citation of citations) {
    const match = /#\^p(\d+)$/.exec(citation.href);
    if (match === null) continue;
    const chunks = cited.get(citation.path) ?? new Set<number>();
    chunks.add(Number(match[1]));
    cited.set(citation.path, chunks);
  }
  return cited;
};

const isRead = (source: SourceRef) => source.type === "article" || source.type === "raw";

export const researchRounds = (
  sources: readonly SourceRef[],
  citations: readonly Citation[] = [],
): ResearchRound[] => {
  const resolved = new Map(
    sources.filter((source) => isRead(source) && !source.pending).map((s) => [s.label, s]),
  );
  const hits = new Map<string, Set<number>>();
  for (const source of sources) {
    if (source.path === null) continue;
    for (const hit of source.hits ?? []) {
      const chunks = hits.get(hit.path) ?? new Set<number>();
      for (const chunk of hit.chunks) if (chunk >= 0) chunks.add(chunk);
      hits.set(hit.path, chunks);
    }
  }
  const cited = citedSections(citations);
  const reads = new Map<string, ReadStep & { fetching: Set<number> }>();
  const steps: ResearchStep[] = [];
  for (const source of sources) {
    if (source.type !== "article" && source.type !== "raw") {
      steps.push({ kind: source.type, source, pending: source.pending === true });
      continue;
    }
    const existing = reads.get(source.label);
    if (existing !== undefined) {
      if (source.pending) for (const chunk of sections(source.ranges)) existing.fetching.add(chunk);
      continue;
    }
    const doc = resolved.get(source.label) ?? source;
    const step = {
      kind: "read" as const,
      source: doc,
      pending: doc.pending === true,
      read: new Set(
        doc.pending
          ? []
          : doc.full && doc.chunks !== undefined
            ? Array.from({ length: doc.chunks }, (_, index) => index)
            : sections(doc.ranges),
      ),
      fetching: new Set(source.pending && source !== doc ? sections(source.ranges) : []),
      hits: hits.get(source.label) ?? new Set<number>(),
      cited: cited.get(source.label) ?? new Set<number>(),
    };
    reads.set(source.label, step);
    steps.push(step);
  }

  const rounds: { key: string; note: string | null; steps: ResearchStep[] }[] = [];
  steps.forEach((step, index) => {
    const round = step.source.round;
    const last = rounds.at(-1);
    if (round !== undefined && last?.key === `round:${round}`) last.steps.push(step);
    else {
      const note = step.source.thinking?.trim() || null;
      rounds.push({
        key: round === undefined ? `step:${index}` : `round:${round}`,
        note: note !== null && note === last?.note ? null : note,
        steps: [step],
      });
    }
  });
  return rounds;
};

const spans = (sections: ReadonlySet<number>) => {
  const runs: [number, number][] = [];
  for (const section of [...sections].sort((a, b) => a - b)) {
    const last = runs.at(-1);
    if (last !== undefined && section === last[1] + 1) last[1] = section;
    else runs.push([section, section]);
  }
  return runs.map(([from, to]) => (from === to ? `§${from + 1}` : `§${from + 1}–${to + 1}`));
};

export const readLabel = (step: ReadStep) => {
  if (step.pending) return "";
  if (step.fetching.size > 0) return `fetching ${spans(step.fetching).join(", ")}…`;
  const chunks = step.source.chunks;
  if (step.source.full === true) return "read in full";
  const read = spans(step.read).join(", ");
  if (step.source.outline === true)
    return read === ""
      ? `outline${chunks === undefined ? "" : ` · ${chunks} sections`}`
      : `outline · ${read}${chunks === undefined ? "" : ` of ${chunks}`}`;
  return read === "" ? "" : `${read}${chunks === undefined ? "" : ` of ${chunks}`}`;
};

// While tools run, the reply's answer still holds the text the model wrote
// before calling them; that text is shown as the round's note instead.
export const answerText = (exchange: Exchange) => {
  const answer = exchange.answer.trim();
  return exchange.status === "running" &&
    answer !== "" &&
    exchange.thinking.some((block) =>
      block.sources.some((source) => source.thinking?.trim() === answer),
    )
    ? ""
    : exchange.answer;
};
