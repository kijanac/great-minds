import { useCallback } from "react"
import { useNavigate } from "react-router"

/**
 * Returns a click handler that intercepts internal knowledge base links
 * and routes them through react-router instead of full page navigation.
 *
 * Handles:
 *   wiki/slug.md        → /wiki/slug
 *   raw/texts/...       → /wiki/slug (opens panel) — TODO: raw source viewer
 *   #anchor             → browser default (scroll)
 *   http(s)://...       → browser default (new tab via target=_blank on the <a>)
 */
export function useLinkInterceptor() {
  const navigate = useNavigate()

  return useCallback(
    (e: React.MouseEvent) => {
      const anchor = (e.target as Element).closest("a")
      if (!anchor) return

      const href = anchor.getAttribute("href")
      if (!href) return

      // External links — let browser handle (they should have target=_blank)
      if (href.startsWith("http://") || href.startsWith("https://")) return

      // Anchor links — let browser handle
      if (href.startsWith("#")) return

      // Everything else is an internal KB path — prevent default navigation
      e.preventDefault()

      // Wiki article links: wiki/slug.md → /wiki/slug
      if (href.startsWith("wiki/") && href.endsWith(".md")) {
        const slug = href.slice(5, -3)
        navigate(`/wiki/${slug}`)
        return
      }

      // Wiki article links without extension: wiki/slug → /wiki/slug
      if (href.startsWith("wiki/")) {
        const slug = href.slice(5)
        navigate(`/wiki/${slug}`)
        return
      }
    },
    [navigate],
  )
}
