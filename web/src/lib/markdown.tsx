import type { ComponentProps } from "react"
import type Markdown from "react-markdown"
import remarkGfm from "remark-gfm"

export const remarkPlugins = [remarkGfm]

/** Leaf markdown overrides shared across all contexts (answer-block, article-view, btw-thread). */
export const baseMdComponents: ComponentProps<typeof Markdown>["components"] = {
  a: ({ children, href }) => {
    const isExternal = href?.startsWith("http")
    return (
      <a
        href={href}
        className="text-gold underline underline-offset-2 decoration-gold/30 hover:decoration-gold/60 transition-colors"
        {...(isExternal ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      >
        {children}
      </a>
    )
  },
  em: ({ children }) => <em className="text-warm">{children}</em>,
  strong: ({ children }) => (
    <strong className="text-foreground font-bold">{children}</strong>
  ),
}
