import { describe, expect, it } from "vitest";
import { render } from "svelte/server";

import { uniqueQuoteSpan } from "#lib/anchor.ts";
import { placeAnchors } from "#lib/anchor-marks.ts";
import { assignBlockRefIds, stripBlockRefMarkers } from "#lib/block-refs.ts";
import ConversationAbout from "#lib/components/conversation-about.svelte";
import { parseMarkdown } from "#lib/markdown.ts";
import type { HastNode } from "#lib/markdown-plugins.ts";
import type { TextAnchor } from "#lib/types.ts";

describe("saved passage anchors", () => {
  const anchor = (fields: Partial<TextAnchor> & Pick<TextAnchor, "quote">): TextAnchor => ({
    context: "",
    section: null,
    occurrence: null,
    ...fields,
  });
  const source = (text: string) => {
    const tree = parseMarkdown(stripBlockRefMarkers(text));
    assignBlockRefIds(tree, text);
    return tree;
  };
  const blockAt = (tree: HastNode, index: number) =>
    tree.children?.filter((child) => child.type === "element")[index]?.position?.start?.offset;

  it("does not guess between repeats of a quote it has no occurrence for", () => {
    const tree = parseMarkdown("The claim matters. The claim needs evidence.");
    const placed = placeAnchors(tree, [
      { threadId: "t", anchor: anchor({ quote: "The claim" }), mark: true },
    ]);
    expect(placed.size).toBe(0);
    expect(JSON.stringify(tree)).not.toContain('"tagName":"mark"');
  });

  it("highlights a unique quote across formatting and keeps the original text", () => {
    const tree = parseMarkdown("A **clear** claim.");
    const result = placeAnchors(tree, [
      { threadId: "saved", anchor: anchor({ quote: "clear claim", occurrence: 1 }), mark: true },
    ]);
    expect(result.get("saved")).toEqual({ offset: 0, start: 2, end: 13 });
    expect(JSON.stringify(tree)).toContain('"dataThreadId":"saved"');
    expect(JSON.stringify(tree)).toContain('"tagName":"strong"');
  });

  it("finds a repeated quote by its section and occurrence, and by the quote when sections move", () => {
    const tree = source(
      "The claim matters. ^p0\n\nThe claim holds, the claim stands. ^p1\n\nNothing else. ^p2",
    );
    const place = (fields: Partial<TextAnchor>) =>
      placeAnchors(tree, [
        { threadId: "t", anchor: anchor({ quote: "The claim", ...fields }), mark: false },
      ]).get("t");
    expect(place({ section: 1, occurrence: 1 })).toMatchObject({
      offset: blockAt(tree, 1),
      start: 0,
    });
    expect(place({ section: null, occurrence: 1 })).toMatchObject({ offset: blockAt(tree, 0) });
    expect(
      placeAnchors(tree, [
        {
          threadId: "t",
          anchor: anchor({ quote: "the claim", section: 1, occurrence: 1 }),
          mark: false,
        },
      ]).get("t"),
    ).toMatchObject({ start: 17 });
    expect(
      placeAnchors(tree, [
        {
          threadId: "t",
          anchor: anchor({ quote: "Nothing else", section: 7, occurrence: 1 }),
          mark: false,
        },
      ]).get("t"),
    ).toMatchObject({ offset: blockAt(tree, 2) });
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
          section: null,
          occurrence: 1,
        },
        title: "A source",
        href: null,
      },
    });
    const text = body.replace(/<[^>]*>/g, "");
    expect(text).toContain("A source");
    expect(text).toContain("clear claim");
    expect(body.includes("aria-expanded")).toBe(toggle);
  });

  it("exposes one keyboard trigger across formatting while preserving linked text", () => {
    const quote = "linked text and a clear claim";
    const tree = parseMarkdown("Read [linked text](wiki/evidence.md) and a **clear claim**.");
    placeAnchors(tree, [
      { threadId: "saved", anchor: anchor({ quote, occurrence: 1 }), mark: true },
    ]);
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
