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

/** Flatten a footnote definition node to plain text (sans the ↩ backref), so
 * the reference marker can preview its source on hover. */
export function footnoteText(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  if (node.tagName === "a" && node.properties?.dataFootnoteBackref) return "";
  return (node.children ?? []).map(footnoteText).join("");
}

/** Attach each footnote's resolved text to its `[^N]` reference as
 * `data-footnote-content`, so the renderer can preview it in a hover tooltip
 * instead of making the reader scroll to the footnote section. */
export function rehypeFootnoteContent() {
  return (tree: HastNode): undefined => {
    const byId: Record<string, string> = {};
    const collect = (node: HastNode): void => {
      const id = node.properties?.id;
      if (node.tagName === "li" && typeof id === "string") {
        byId[id] = footnoteText(node).replace(/\s+/g, " ").trim();
      }
      (node.children ?? []).forEach(collect);
    };
    const attach = (node: HastNode): void => {
      const props = node.properties;
      if (
        props &&
        node.tagName === "a" &&
        props.dataFootnoteRef === true &&
        typeof props.href === "string" &&
        props.href.startsWith("#")
      ) {
        const content = byId[props.href.slice(1)];
        if (content) props.dataFootnoteContent = content;
      }
      (node.children ?? []).forEach(attach);
    };
    collect(tree);
    attach(tree);
  };
}

export const rehypePlugins = [rehypeFootnoteSeparators, rehypeFootnoteContent];
