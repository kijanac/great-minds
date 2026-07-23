import remarkGfm from "remark-gfm";

export const remarkPlugins = [remarkGfm];

// Minimal hast-ish shape — enough to walk the tree and insert separator
// nodes without pulling in @types/hast.
export interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  position?: {
    start?: { line?: number; column?: number; offset?: number };
    end?: { line?: number; column?: number; offset?: number };
  };
}

function isFootnoteRefSup(node: HastNode): boolean {
  return (
    node.type === "element" &&
    node.tagName === "sup" &&
    (node.children ?? []).some(
      (child) =>
        child.type === "element" &&
        child.tagName === "a" &&
        child.properties?.dataFootnoteRef === true,
    )
  );
}

/** Separate consecutive footnote references with a comma.
 *
 * remark-gfm renders each ref as its own <sup>, so back-to-back citations
 * (`[^2][^3]`) render as touching superscripts ("23"). We insert a comma
 * between *truly adjacent* refs — the interactive-web reading of the
 * AMA/Vancouver convention. (We don't collapse runs into a dash like print
 * does: "4-6" would hide the clickable link for ref 5.)
 *
 * This must be a tree transform, not a custom <sup> component: adjacency is a
 * sibling relationship a component can't see, and CSS `sup + sup` can't express
 * it either — the adjacent-sibling combinator ignores text nodes between refs
 * that sit in different sentences, so it over-matches.
 */
export function rehypeFootnoteSeparators() {
  return (tree: HastNode): undefined => {
    const walk = (node: HastNode): void => {
      if (!node.children) return;
      const children = node.children;
      const out: HastNode[] = [];
      children.forEach((child, index) => {
        if (index > 0 && isFootnoteRefSup(child) && isFootnoteRefSup(children[index - 1])) {
          out.push({
            type: "element",
            tagName: "sup",
            properties: { className: ["footnote-sep"] },
            children: [{ type: "text", value: "," }],
          });
        }
        out.push(child);
        walk(child);
      });
      node.children = out;
    };
    walk(tree);
  };
}
