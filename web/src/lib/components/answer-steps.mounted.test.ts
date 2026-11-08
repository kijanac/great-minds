import { flushSync, mount, unmount } from "svelte";
import { expect, it } from "vitest";

import type { SourceRef } from "#lib/types.ts";
import AnswerSteps from "./answer-steps.svelte";

const step = (source: Partial<SourceRef> & Pick<SourceRef, "type" | "label">): SourceRef => ({
  document_id: null,
  title: null,
  scope: null,
  path: null,
  thinking: null,
  ...source,
});

const blocks = [
  {
    sources: [
      step({ type: "query", label: "contains: centralism, sort: central" }),
      step({ type: "search", label: "party discipline 1921", scope: "kb" }),
      step({
        type: "article",
        label: "wiki/rsdlp.md",
        title: "Democratic Centralism in the R.S.D.L.P.",
      }),
      step({ type: "raw", label: "raw/docs/a.md", title: "Letter to Martov" }),
      step({ type: "raw", label: "raw/docs/a.md", title: "Letter to Martov" }),
    ],
  },
];

it("shows the current step while answering and what it rests on once done", () => {
  const target = document.createElement("div");
  document.body.append(target);
  const live = mount(AnswerSteps, {
    target,
    props: { blocks, streaming: true, onOpen: () => {} },
  });
  flushSync();
  expect(target.textContent?.replace(/\s+/g, " ").trim()).toBe(
    "read source Letter to Martov 5 steps · 2 read so far",
  );
  unmount(live);

  const done = mount(AnswerSteps, {
    target,
    props: { blocks, streaming: false, onOpen: () => {} },
  });
  flushSync();
  expect(target.textContent?.replace(/\s+/g, " ").trim()).toBe(
    "Answered from 1 article and 1 source · 5 steps",
  );
  target.querySelector("button")?.click();
  flushSync();
  expect(
    [...target.querySelectorAll("li")].map((li) => li.textContent?.replace(/\s+/g, " ").trim()),
  ).toEqual([
    "listed articles about “centralism”",
    "searched “party discipline 1921”",
    "read article Democratic Centralism in the R.S.D.L.P.",
    "read source Letter to Martov",
    "read source Letter to Martov",
  ]);
  unmount(done);
  target.remove();
});
