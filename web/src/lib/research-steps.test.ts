import { citationsOf, Uuid } from "@great-minds/domain";
import { expect, it } from "vitest";

import {
  answerText,
  readLabel,
  readingTrail,
  researchRounds,
  type ReadStep,
} from "#lib/research-steps.ts";
import type { Exchange, SourceRef } from "#lib/types.ts";

const source = (fields: Partial<SourceRef> & Pick<SourceRef, "type" | "label">): SourceRef => ({
  document_id: null,
  title: null,
  scope: null,
  path: null,
  thinking: null,
  ...fields,
});
const note = "Start with what the library says.";
const sources = [
  source({
    type: "search",
    label: "boycott",
    scope: "kb",
    path: "raw/against.md",
    round: 1,
    thinking: note,
    results: 3,
    hits: [{ path: "raw/against.md", title: "Against Boycott", chunks: [-1, 9, 11] }],
  }),
  source({
    type: "article",
    label: "wiki/tactics.md",
    round: 1,
    thinking: note,
    full: true,
    chunks: 6,
    ranges: [],
  }),
  source({
    type: "raw",
    label: "raw/against.md",
    round: 2,
    thinking: note,
    full: false,
    outline: true,
    chunks: 31,
    ranges: [{ start: 9, end: 13 }],
  }),
];
const answer = "He argued [it](raw/against.md#^p10), as [the article](wiki/tactics.md) says.";
const citations = citationsOf(answer);
const read = (list: readonly SourceRef[], label: string) =>
  researchRounds(list, answer)
    .flatMap((round) => round.steps)
    .find((step): step is ReadStep => step.kind === "read" && step.source.label === label);

it("groups each round, merges a repeat read into its document and marks what was found and cited", () => {
  const pendingRepeat = source({
    type: "raw",
    label: "raw/against.md",
    round: 3,
    pending: true,
    ranges: [{ start: 20, end: 21 }],
  });
  const rounds = researchRounds([...sources, pendingRepeat], answer);
  expect(rounds.map((round) => [round.note, round.steps.map((step) => step.kind)])).toEqual([
    [note, ["search", "read"]],
    [null, ["read"]],
  ]);
  const against = read([...sources, pendingRepeat], "raw/against.md");
  expect([...(against?.read ?? [])]).toEqual([9, 10, 11, 12, 13]);
  expect([...(against?.fetching ?? [])]).toEqual([20, 21]);
  expect([...(against?.hits ?? [])]).toEqual([9, 11]);
  expect([...(against?.cited ?? [])]).toEqual([10]);
  expect(against && readLabel(against)).toBe("fetching §21–22…");
  expect([...(read(sources, "wiki/tactics.md")?.read ?? [])]).toEqual([0, 1, 2, 3, 4, 5]);
  expect(readLabel(read(sources, "wiki/tactics.md")!)).toBe("read in full");
  expect(readLabel(read(sources, "raw/against.md")!)).toBe("outline · §10–14 of 31");
});

const exchange = (answer: string, status: Exchange["status"]): Exchange => ({
  id: Uuid.make("00000000-0000-4000-8000-000000000001"),
  query: "Why?",
  thinking: [{ sources }],
  answer,
  citations,
  btws: [],
  status,
  version: 1,
});

it("traces how a document was found, searched inside and cited", () => {
  const trail = readingTrail(exchange(answer, "completed"), "raw/against.md", 9);
  expect(trail).toMatchObject({ found: null, within: [sources[0]], focus: 9 });
  expect([...(trail?.cited ?? [])]).toEqual([[10, 1]]);
  expect(readingTrail(exchange(answer, "completed"), "raw/missing.md")).toBeNull();
});

it("treats text written before a tool call as the round's note, not the answer", () => {
  expect(answerText(exchange(` ${note}`, "running"))).toBe("");
  expect(answerText(exchange("The answer.", "running"))).toBe("The answer.");
  expect(answerText(exchange(note, "completed"))).toBe(note);
});
