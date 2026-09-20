import { describe, expect, it } from "vitest";
import { render } from "svelte/server";

import { uniqueQuoteSpan } from "$lib/anchor";
import { wrapAnchors } from "$lib/anchor-marks";
import SessionPassage from "$lib/components/session-passage.svelte";
import { parseMarkdown } from "$lib/markdown";
import type { HastNode } from "$lib/markdown-plugins";

describe("saved passage anchors", () => {
  it("preserves a paragraph association without highlighting either repeated phrase", () => {
    const result = wrapAnchors(parseMarkdown("The claim matters. The claim needs evidence."), [
      { threadId: "recovered", blockOffset: 0, quote: "The claim" },
    ]);
    expect(result.misses).toEqual([
      { threadId: "recovered", blockOffset: 0, quote: "The claim", reason: "quote-unresolved" },
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
    expect(uniqueQuoteSpan("A clear claim.", "clear claim")).toEqual({ start: 2, end: 13 });
  });

  it.each([
    { name: "unique quote", quote: "clear claim", context: "A clear claim needs evidence." },
    { name: "list selection", quote: "First item\nSecond item", context: "First itemSecond item" },
    {
      name: "repeated quote",
      quote: "The claim",
      context: "The claim matters. The claim needs evidence.",
    },
    { name: "quote without context", quote: "clear claim", context: null },
  ])("keeps the saved selection and available context visible: $name", ({ quote, context }) => {
    const { body } = render(SessionPassage, { props: { quote, context } });
    expect(body.match(/<mark\b[^>]*>([\s\S]*?)<\/mark>/)?.[1]).toBe(quote);
    if (context) expect(body.replace(/<[^>]*>/g, "")).toContain(context);
    if (context === null || uniqueQuoteSpan(context, quote)) {
      expect(body.split(quote)).toHaveLength(2);
    }
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
    expect(triggers[0]?.properties).toMatchObject({ tabIndex: 0, ariaLabel: `BTW: ${quote}` });
    const link = nodes.find((node) => node.tagName === "a");
    expect(link?.properties?.href).toBe("wiki/evidence.md");
    expect(JSON.stringify(link)).not.toContain('"role":"button"');
  });
});
