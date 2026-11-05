import type { pipelineRuns } from "@great-minds/database";
import type { PipelineProgressStep } from "@great-minds/domain";
import { describe, expect, it } from "vitest";

import { runTrack } from "../src/run-track.ts";

type Row = typeof pipelineRuns.$inferSelect;

const step = (
  key: string,
  status: PipelineProgressStep["status"],
  done: number | null = null,
  total: number | null = null,
): PipelineProgressStep => ({ key, label: key, status, done, total, detail: "" });

const run = (overrides: Partial<Row>): Row => ({
  id: "00000000-0000-4000-8000-000000000001" as Row["id"],
  vaultId: "00000000-0000-4000-8000-000000000002" as Row["vaultId"],
  trigger: "manual",
  status: "running",
  currentPhase: "",
  phaseStatus: "",
  stages: [],
  warnings: [],
  outcome: null,
  error: null,
  ingestTaskId: null,
  compileIntentId: null,
  compileTaskId: null,
  activeTaskId: null,
  activeTaskType: null,
  createdAt: new Date("2026-11-04T17:25:44Z"),
  updatedAt: new Date("2026-11-04T17:30:00Z"),
  completedAt: null,
  ...overrides,
});

const summary = (row: Row) =>
  runTrack(row).map((stage) => [
    stage.key,
    stage.status,
    stage.steps.map((s) => s.status).join(","),
  ]);

describe("run track", () => {
  it("folds an Update's pipeline phases into five reader stages with live counts", () => {
    const row = run({
      currentPhase: "render",
      stages: [
        { phase: "ingest", steps: [step("index_sources", "completed")] },
        {
          phase: "extract",
          steps: [
            step("extract_cards", "completed", 8355, 8355),
            step("embed_ideas", "completed", 0, 0),
          ],
        },
        {
          phase: "abstract",
          steps: [
            step("propose_topics", "completed", 8297, 8297),
            step("group_topics", "completed", 22827, 22827),
            step("build_articles", "completed", 12852, 12852),
          ],
        },
        { phase: "derive", steps: [step("find_related", "completed", 428, 428)] },
        {
          phase: "render",
          steps: [
            step("write_articles", "running", 212, 428),
            step("link_articles", "pending"),
            step("index_articles", "pending"),
          ],
        },
      ],
      warnings: [
        {
          phase: "extract",
          message: "of 8355 documents could not be read",
          count: 22,
          items: ["Das Kapital"],
        },
        { phase: "link_articles", message: "link questions failed", count: 3, items: [] },
      ],
    });
    expect(summary(row)).toEqual([
      ["reading", "completed", "completed,completed,completed"],
      ["topics", "completed", "completed"],
      ["articles", "completed", "completed,completed,completed"],
      ["writing", "running", "running"],
      ["linking", "pending", "pending,pending,pending,pending,pending"],
    ]);
    const track = runTrack(row);
    expect(track[3]?.steps[0]).toMatchObject({ label: "Writing articles", done: 212, total: 428 });
    expect(track[0]?.warnings.map((warning) => warning.count)).toEqual([22]);
    expect(track[4]?.warnings.map((warning) => warning.count)).toEqual([3]);
  });

  it("marks where a failed run stopped and leaves later stages unstarted", () => {
    const row = run({
      status: "failed",
      currentPhase: "extract",
      phaseStatus: "failed",
      stages: [
        { phase: "ingest", steps: [step("index_sources", "completed")] },
        {
          phase: "extract",
          steps: [step("extract_cards", "running", 10, 8355), step("embed_ideas", "pending")],
        },
      ],
    });
    expect(summary(row).map(([key, status]) => [key, status])).toEqual([
      ["reading", "failed"],
      ["topics", "pending"],
      ["articles", "pending"],
      ["writing", "pending"],
      ["linking", "pending"],
    ]);
  });

  it("starts an upload's track with the upload stage", () => {
    const row = run({
      trigger: "staged_files",
      currentPhase: "source_ingest",
      stages: [
        {
          phase: "source_ingest",
          steps: [
            step("prepare_sources", "completed", 3, 3),
            step("read_files", "running", 1, 3),
            step("index_documents", "pending"),
          ],
        },
      ],
    });
    expect(summary(row).map(([key, status]) => [key, status])).toEqual([
      ["upload", "running"],
      ["reading", "pending"],
      ["topics", "pending"],
      ["articles", "pending"],
      ["writing", "pending"],
      ["linking", "pending"],
    ]);
  });
});
