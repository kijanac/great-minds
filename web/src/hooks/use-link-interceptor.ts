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
      const anchor = (e.target as Element).closest("a");
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

      // Raw source links — open panel or navigate to full-screen doc view
      if (href.startsWith("raw/")) {
        e.preventDefault();
        if (onDocOpen) {
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
