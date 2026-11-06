import { flushSync, mount, unmount } from "svelte";
import { expect, it, vi } from "vitest";

import { citationsOf } from "@great-minds/domain";

import type { Citation } from "$lib/citations";
import AnswerBlock from "./answer-block.svelte";

it("on a phone, a citation number opens a source card and each answer lists its sources", () => {
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: false,
    media,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const opened: Citation[] = [];
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(AnswerBlock, {
    target,
    props: {
      text: "Lenin wrote [to Martov](raw/docs/a.md#^p4) and [the article](wiki/rsdlp.md).",
      citations: citationsOf(
        "Lenin wrote [to Martov](raw/docs/a.md#^p4) and [the article](wiki/rsdlp.md).",
      ),
      exchangeId: "00000000-0000-4000-8000-000000000001" as never,
      btws: [],
      streaming: false,
      onCitation: (citation: Citation) => opened.push(citation),
    },
  });
  flushSync();
  const refs = [...target.querySelectorAll<HTMLButtonElement>("[data-citation-ref]")];
  expect(refs.map((ref) => ref.textContent)).toEqual(["1", "2"]);
  expect(target.querySelector("summary")?.textContent?.replace(/\s+/g, " ").trim()).toBe(
    "2 sources",
  );

  refs[1]?.click();
  flushSync();
  const card = target.querySelector("[data-citation-card]");
  expect(card?.textContent?.replace(/\s+/g, " ").trim()).toBe("2the article article open");
  card?.querySelector("button")?.click();
  flushSync();
  expect(opened.map((citation) => citation.path)).toEqual(["wiki/rsdlp.md"]);
  expect(target.querySelector("[data-citation-card]")).toBeNull();

  unmount(component);
  target.remove();
  vi.unstubAllGlobals();
});
