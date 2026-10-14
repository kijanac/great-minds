import { expect, it } from "vitest";
import { assignBlockRefIds, stripBlockRefMarkers } from "$lib/block-refs";
import { parseMarkdown } from "$lib/markdown";
import type { HastNode } from "$lib/markdown-plugins";

it("keeps heading and recorded passage destinations distinct and addressable", () => {
  const source =
    "# Evidence ^p0\n\nA recorded paragraph. ^p7\n\n## Evidence\n\n### *Another* heading";
  const tree = parseMarkdown(stripBlockRefMarkers(source));
  assignBlockRefIds(tree, source);
  const ids: unknown[] = [];
  const collect = (node: HastNode) => {
    if (node.properties?.id) ids.push(node.properties.id);
    node.children?.forEach(collect);
  };
  collect(tree);
  expect(ids).toEqual(["evidence", "^p0", "^p7", "evidence-1", "another-heading"]);
});
