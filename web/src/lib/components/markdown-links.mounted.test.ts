import { flushSync, mount, unmount } from "svelte";
import { expect, it } from "vitest";

import MarkdownView from "./markdown-view.svelte";

it("renders only supported destinations while retaining labels and image descriptions", async () => {
  const target = document.createElement("div");
  const component = mount(MarkdownView, {
    target,
    props: {
      source: [
        "[Wiki](wiki/article.md) [Passage](raw/docs/report.md#^p12) [Section](#notes)",
        "[Published](HTTPS://example.test/doc/wiki/article.md?vault=original#section)",
        "[Email](mailto:editor@example.test) [**Book ID**](urn:isbn:9780140449136)",
        "![Chart](https://example.test/chart.png) ![Map](refs/map.png)",
      ].join("\n\n"),
    },
  });
  try {
    flushSync();
    expect([...target.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual([
      "wiki/article.md",
      "raw/docs/report.md#%5Ep12",
      "#notes",
      "https://example.test/doc/wiki/article.md?vault=original#section",
      "mailto:editor@example.test",
    ]);
    expect(target.querySelector("[target='_blank']")?.getAttribute("rel")).toBe(
      "noopener noreferrer",
    );
    expect(target.querySelector("strong")?.textContent).toBe("Book ID");
    expect([...target.querySelectorAll("img")].map((image) => image.getAttribute("src"))).toEqual([
      "https://example.test/chart.png",
    ]);
    expect(target.textContent).toContain("Map");
  } finally {
    await unmount(component);
  }
});
