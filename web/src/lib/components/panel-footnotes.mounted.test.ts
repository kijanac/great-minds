import { flushSync, mount, unmount } from "svelte";
import { expect, it, vi } from "vitest";

import MarkdownView from "./markdown-view.svelte";

it("shows a panel chunk with its own footnotes as numbered popover markers, no visible list", () => {
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
  const source =
    'Then it spread[^2][^1].\n\n[^2]: [Source B](raw/books/capital.md) — "spread"\n[^1]: [Source A](raw/books/capital.md#^p2) — "grew"';
  const component = mount(MarkdownView, {
    target,
    props: { source, variant: "panel", stripBlockRefs: true },
  });
  flushSync();
  const paragraph = target.querySelector("p");
  const refs = [...target.querySelectorAll("[data-footnote-ref]")];
  expect({
    text: paragraph?.textContent,
    refs: refs.length,
    popoverTriggers: target.querySelectorAll("[data-popover-trigger]").length,
    hiddenList: target.querySelector("[data-footnotes]") !== null,
  }).toEqual({ text: "Then it spread1,2.", refs: 2, popoverTriggers: 2, hiddenList: true });
  unmount(component);
  target.remove();
  vi.unstubAllGlobals();
});
