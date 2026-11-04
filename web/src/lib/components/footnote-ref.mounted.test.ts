import { flushSync, mount, unmount } from "svelte";
import { expect, it, vi } from "vitest";

import MarkdownView from "./markdown-view.svelte";

it("keeps a footnote number tight against the text and punctuation on small screens", () => {
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
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(MarkdownView, {
    target,
    props: {
      source: 'Should conditions change[^1].\n\n[^1]: [Source](raw/a.md) — "quote"\n',
      variant: "article",
      marginFootnotes: true,
    },
  });
  flushSync();
  expect(target.querySelector("p")?.textContent).toBe("Should conditions change1.");
  unmount(component);
  target.remove();
  vi.unstubAllGlobals();
});
