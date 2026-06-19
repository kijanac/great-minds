import { useEffect } from "react";
import { useLocation } from "react-router";

/**
 * Scrolls the element matching the URL hash into view after render.
 *
 * react-router does no native hash scrolling on client navigation, so we sync
 * the browser's scroll position to the hash ourselves once the target is
 * committed. `:target` CSS handles any highlight.
 *
 * Pass `contentKey` — anything whose identity changes when the anchored content
 * (re)renders, e.g. a route's loader data — so the scroll re-runs when the
 * target first appears or when a different document loads under the same hash.
 */
export function useScrollToHash(contentKey?: unknown): void {
  const { hash } = useLocation();

  useEffect(() => {
    if (!hash) return;
    const el = document.getElementById(decodeURIComponent(hash.slice(1)));
    if (el) requestAnimationFrame(() => el.scrollIntoView({ block: "start" }));
  }, [hash, contentKey]);
}
