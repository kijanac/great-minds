import { describe, expect, it } from "vitest";
import { render } from "svelte/server";

import { uniqueQuoteSpan } from "#lib/anchor.ts";
import { wrapAnchors } from "#lib/anchor-marks.ts";
import ConversationAbout from "#lib/components/conversation-about.svelte";
import { parseMarkdown } from "#lib/markdown.ts";
import type { HastNode } from "#lib/markdown-plugins.ts";

describe("saved passage anchors", () => {
  it("preserves a paragraph association without highlighting either repeated phrase", () => {
    const result = wrapAnchors(parseMarkdown("The claim matters. The claim needs evidence."), [
      { threadId: "recovered", blockOffset: 0, quote: "The claim" },
    ]);
    expect(result.misses).toEqual([
      {
        threadId: "recovered",
        blockOffset: 0,
        quote: "The claim",
        reason: "quote-unresolved",
      },
    ]);
    expect(JSON.stringify(result.tree)).not.toContain('"tagName":"mark"');
  });

  it("highlights a unique quote across formatting and keeps the original text", () => {
    const result = wrapAnchors(parseMarkdown("A **clear** claim."), [
      { threadId: "saved", blockOffset: 0, quote: "clear claim" },
    ]);
    expect(result.misses).toEqual([]);
    expect(JSON.stringify(result.tree)).toContain('"dataThreadId":"saved"');
    expect(JSON.stringify(result.tree)).toContain('"tagName":"strong"');
  });

  it("does not treat overlapping occurrences as a unique selection", () => {
    expect(uniqueQuoteSpan("banana", "ana")).toBeNull();
    expect(uniqueQuoteSpan("A clear claim.", "clear claim")).toEqual({
      start: 2,
      end: 13,
    });
  });

  it.each([
    { name: "with surrounding passage", paragraph: "A clear claim needs evidence.", toggle: true },
    { name: "passage is the quote", paragraph: "clear claim", toggle: false },
    { name: "no passage", paragraph: null, toggle: false },
  ])("says what an anchored conversation is about: $name", ({ paragraph, toggle }) => {
    const { body } = render(ConversationAbout, {
      props: {
        origin: {
          kind: "document",
          doc_path: "raw/a.md",
          origin_scope: "vault",
          anchor: "clear claim",
          paragraph,
          paragraph_index: null,
        },
        title: "A source",
        href: null,
      },
    });
    const text = body.replace(/<[^>]*>/g, "");
    expect(text).toContain("A source");
    expect(text.split("clear claim")).toHaveLength(2);
    expect(text.includes("show passage")).toBe(toggle);
    expect(text).not.toContain("needs evidence");
  });

  it("exposes one keyboard trigger across formatting while preserving linked text", () => {
    const quote = "linked text and a clear claim";
    const { tree } = wrapAnchors(
      parseMarkdown("Read [linked text](wiki/evidence.md) and a **clear claim**."),
      [{ threadId: "saved", blockOffset: 0, quote }],
    );
    const nodes: HastNode[] = [];
    const visit = (node: HastNode): void => {
      nodes.push(node);
      for (const child of node.children ?? []) visit(child);
    };
    visit(tree);
    const triggers = nodes.filter((node) => node.properties?.role === "button");
    expect(triggers).toHaveLength(1);
    expect(triggers[0]?.properties).toMatchObject({
      tabIndex: 0,
      ariaLabel: `BTW: ${quote}`,
    });
    const link = nodes.find((node) => node.tagName === "a");
    expect(link?.properties?.href).toBe("wiki/evidence.md");
    expect(JSON.stringify(link)).not.toContain('"role":"button"');
  });
});
