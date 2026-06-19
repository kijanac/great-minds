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
    const id = decodeURIComponent(hash.slice(1));
    let raf = 0;
    let tries = 0;
    // On a client-side navigation the target block may not be painted in the
    // first frame (a direct page load is saved by the browser's own hash
    // scroll; a client nav isn't). Retry for a few frames until it exists.
    const attempt = () => {
      const el = document.getElementById(id);
      if (el) {
        el.scrollIntoView({ block: "start" });
      } else if (tries++ < 30) {
        raf = requestAnimationFrame(attempt);
      }
    };
    raf = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(raf);
  }, [hash, contentKey]);
}
