import { goto } from "$app/navigation";
import { flushSync, mount, unmount } from "svelte";
import { expect, it, vi } from "vitest";

import { usePanelCard } from "$lib/hooks/use-panel-card.svelte";
import type { PanelContent } from "$lib/panel-content";
import ArticlePanel from "./article-panel.svelte";

vi.mock("$app/navigation", () => ({ goto: vi.fn() }));

it.each(["doc", "chunks"] as const)(
  "opens a source passage from %s panel Markdown",
  async (mode) => {
    vi.mocked(goto).mockClear();
    const card = usePanelCard();
    card.openPath("wiki/overview.md");
    const body = "[Cited source](raw/docs/source.md#%5Ep64)";
    const content: PanelContent =
      mode === "doc"
        ? { mode, body }
        : {
            mode,
            chunks: [
              {
                path: "wiki/overview.md",
                chunk_index: 1,
                heading: "Overview",
                body,
                content_hash: "hash",
              },
            ],
          };
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(ArticlePanel, {
      target,
      props: {
        card: card.selectedCard!,
        content,
        loading: false,
        onClose: card.close,
        onFullScreen: card.maximize,
        onOpenPath: card.openPath,
        onLinkClick: card.onLinkClick,
      },
    });
    try {
      flushSync();
      const link = target.querySelector("a");
      expect(link?.textContent).toBe("Cited source");
      const event = new MouseEvent("click", { bubbles: true, cancelable: true });
      link!.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(card.selectedCard).toMatchObject({
        label: "raw/docs/source.md",
        type: "raw",
        full: false,
        ranges: [{ start: 64, end: 64 }],
      });
      card.maximize();
      expect(goto).toHaveBeenCalledExactlyOnceWith("/doc/raw/docs/source.md#^p64");
    } finally {
      await unmount(component);
      target.remove();
    }
  },
);
