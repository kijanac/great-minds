import { expect, it } from "vitest";
import { stripPassageMarkers } from "@great-minds/domain";

import { assignBlockRefIds } from "#lib/block-refs.ts";
import { parseMarkdown } from "#lib/markdown.ts";
import type { HastNode } from "#lib/markdown-plugins.ts";

it("keeps heading and recorded passage destinations distinct and addressable", () => {
  const source =
    "# Evidence ^p0\n\nA recorded paragraph. ^p7\n\n## Evidence\n\n### *Another* heading";
  const tree = parseMarkdown(stripPassageMarkers(source));
  assignBlockRefIds(tree, source);
  const ids: unknown[] = [];
  const collect = (node: HastNode) => {
    if (node.properties?.id) ids.push(node.properties.id);
    node.children?.forEach(collect);
  };
  collect(tree);
  expect(ids).toEqual(["evidence", "^p0", "^p7", "evidence-1", "another-heading"]);
});

it("gives a code block or table the passage marker written under it", () => {
  const source = "Intro. ^p0\n\n```\ncode\n\nmore\n```\n\n^p1\n\n| a |\n| - |\n| 1 |\n\n^p2";
  const tree = parseMarkdown(stripPassageMarkers(source));
  assignBlockRefIds(tree, source);
  expect(
    tree.children
      ?.filter((node) => node.type === "element")
      .map((node) => [node.tagName, node.properties?.id]),
  ).toEqual([
    ["p", "^p0"],
    ["pre", "^p1"],
    ["table", "^p2"],
  ]);
});
