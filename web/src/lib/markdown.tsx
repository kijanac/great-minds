import type { ComponentProps } from "react";
import type Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export const remarkPlugins = [remarkGfm];

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
