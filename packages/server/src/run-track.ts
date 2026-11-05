import type { pipelineRuns } from "@great-minds/database";
import type { PipelineProgressStep, PipelineWarning, RunStage } from "@great-minds/domain";

import { STAGED_FILE_INGEST_STEP_LABELS } from "./staged-file-ingest-workflow.ts";
import { URL_INGEST_STEP_LABELS } from "./url-ingest-workflow.ts";

type StageDefinition = {
  readonly key: string;
  readonly label: string;
  readonly title: string;
  readonly steps: readonly (readonly [phase: string, key: string, label: string])[];
};

const fromLabels = (labels: Record<string, string>) =>
  Object.entries(labels).map(([key, label]) => ["source_ingest", key, label] as const);

const UPLOAD: StageDefinition = {
  key: "upload",
  label: "Uploading",
  title: "Adding your files",
  steps: fromLabels(STAGED_FILE_INGEST_STEP_LABELS),
};

const FETCH: StageDefinition = {
  key: "fetch",
  label: "Fetching",
  title: "Adding the page",
  steps: fromLabels(URL_INGEST_STEP_LABELS),
};

const COMPILE: readonly StageDefinition[] = [
  {
    key: "reading",
    label: "Reading",
    title: "Reading your sources",
    steps: [
      ["ingest", "index_sources", "Indexing sources for search"],
      ["extract", "extract_cards", "Reading sources"],
      ["extract", "embed_ideas", "Embedding new ideas"],
    ],
  },
  {
    key: "topics",
    label: "Finding topics",
    title: "Finding topics",
    steps: [["abstract", "propose_topics", "Finding each source's topics"]],
  },
  {
    key: "articles",
    label: "Building articles",
    title: "Building articles",
    steps: [
      ["abstract", "group_topics", "Grouping topics into themes"],
      ["abstract", "build_articles", "Building articles from themes"],
      ["derive", "find_related", "Relating articles"],
    ],
  },
  {
    key: "writing",
    label: "Writing",
    title: "Writing articles",
    steps: [["render", "write_articles", "Writing articles"]],
  },
  {
    key: "linking",
    label: "Linking",
    title: "Linking articles",
    steps: [
      ["render", "link_articles", "Linking articles"],
      ["render", "index_articles", "Indexing articles for search"],
      ["verify", "check_links", "Checking references"],
      ["publish", "publish_wiki", "Publishing"],
      ["publish", "finalize_compile", "Finishing"],
    ],
  },
];

const definitionsFor = (trigger: (typeof pipelineRuns.$inferSelect)["trigger"]) =>
  trigger === "staged_files"
    ? [UPLOAD, ...COMPILE]
    : trigger === "url"
      ? [FETCH, ...COMPILE]
      : COMPILE;

export const runTrack = (row: typeof pipelineRuns.$inferSelect): readonly RunStage[] => {
  const stored = new Map(row.stages.map((stage) => [stage.phase, stage.steps]));
  const definitions = definitionsFor(row.trigger);
  const owner = (warning: PipelineWarning) =>
    definitions.find((definition) => definition.steps.some(([, key]) => key === warning.phase)) ??
    definitions.find((definition) => definition.steps.some(([phase]) => phase === warning.phase)) ??
    definitions[0];
  const active = row.status === "pending" || row.status === "running";
  const stageStatus = (steps: readonly PipelineProgressStep[]): RunStage["status"] => {
    if (steps.some((step) => step.status === "failed")) return "failed";
    if (steps.every((step) => step.status === "completed")) return "completed";
    const started = steps.some((step) => step.status !== "pending");
    if (active) return started ? "running" : "pending";
    if (row.status === "completed") return started ? "completed" : "skipped";
    if (row.status === "failed") return started ? "failed" : "pending";
    return "skipped";
  };
  return definitions.map((definition) => {
    const steps = definition.steps.map(([phase, key, label]): PipelineProgressStep => {
      const step = stored.get(phase)?.find((candidate) => candidate.key === key);
      return step === undefined
        ? { key, label, status: "pending", done: null, total: null, detail: "" }
        : { ...step, label };
    });
    const status = stageStatus(steps);
    return {
      key: definition.key,
      label: definition.label,
      title: definition.title,
      status,
      steps,
      warnings: row.warnings.filter((warning) => owner(warning) === definition),
    };
  });
};
