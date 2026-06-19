import { useCallback } from "react";

import { useViewNavigate } from "@/hooks/use-view-navigate";

/**
 * Returns a click handler that intercepts internal knowledge base links
 * and routes them through react-router instead of full page navigation.
 *
 * Handles:
 *   wiki/slug.md        → /doc/wiki/slug.md
 *   wiki/slug            → /doc/wiki/slug
 *   raw/...             → onDocOpen callback (opens panel)
 *   #anchor             → browser default (scroll)
 *   http(s)://...       → browser default (new tab via target=_blank on the <a>)
 */
export function useLinkInterceptor(onDocOpen?: (path: string) => void) {
  const navigate = useViewNavigate();

  return useCallback(
    (e: React.MouseEvent) => {
      if (!(e.target instanceof Element)) return;

      const anchor = e.target.closest("a");
      if (!anchor) return;

      const href = anchor.getAttribute("href");
      if (!href) return;

      // External links — let browser handle (they should have target=_blank)
      if (href.startsWith("http://") || href.startsWith("https://")) return;

      // Anchor links — let browser handle
      if (href.startsWith("#")) return;

      // Wiki article links get full-screen navigation
      if (href.startsWith("wiki/")) {
        e.preventDefault();
        navigate(`/doc/${href}`);
        return;
      }

      // Raw source links. A chunk-anchored citation (…#^p47) deep-links into
      // the full-screen doc view, which scrolls to and highlights that
      // paragraph; a bare doc link opens the side panel (a quicker peek).
      if (href.startsWith("raw/")) {
        e.preventDefault();
        if (onDocOpen && !href.includes("#")) {
          onDocOpen(href);
        } else {
          navigate(`/doc/${href}`);
        }
        return;
      }
    },
    [navigate, onDocOpen],
  );
}
