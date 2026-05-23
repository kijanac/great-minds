import type { ComponentProps } from "react";
import type Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export const remarkPlugins = [remarkGfm];

// Minimal hast-ish shape — enough to walk the tree and insert separator
// nodes without pulling in @types/hast.
interface HastNode {
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
      (c) => c.type === "element" && c.tagName === "a" && c.properties?.dataFootnoteRef === true,
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
function rehypeFootnoteSeparators() {
  return (tree: HastNode): undefined => {
    const walk = (node: HastNode): void => {
      if (!node.children) return;
      const children = node.children;
      const out: HastNode[] = [];
      children.forEach((child, i) => {
        if (i > 0 && isFootnoteRefSup(child) && isFootnoteRefSup(children[i - 1])) {
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

export const rehypePlugins: ComponentProps<typeof Markdown>["rehypePlugins"] = [
  rehypeFootnoteSeparators,
];

/** Leaf markdown overrides shared across all contexts (answer-block, article-view, btw-thread). */
export const baseMdComponents: ComponentProps<typeof Markdown>["components"] = {
  a: ({ node: _node, children, href, ...rest }) => {
    const isExternal = href?.startsWith("http");
    return (
      // Spread the remaining props so remark-gfm's footnote attributes
      // (data-footnote-ref / data-footnote-backref, aria-describedby) survive —
      // the footnote styling and consecutive-ref separator depend on them.
      <a
        href={href}
        {...rest}
        className="text-gold underline underline-offset-2 decoration-gold/30 hover:decoration-gold/60 transition-colors"
        {...(isExternal ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      >
        {children}
      </a>
    );
  },
  em: ({ children }) => <em className="text-warm">{children}</em>,
  strong: ({ children }) => <strong className="text-foreground font-bold">{children}</strong>,
};
