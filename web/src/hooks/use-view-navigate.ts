import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router";

type TransitionType = "depth-down" | "depth-up" | "doc-slide" | "crossfade";

/**
 * Navigate with View Transitions API. Automatically sets a data-transition
 * attribute on <html> so CSS can apply directional animations:
 *
 *   depth-down  — surface → doc (vertical rise)
 *   depth-up    — doc → surface (vertical settle)
 *   doc-slide   — doc → doc (horizontal page turn)
 *   crossfade   — same-depth lateral (opacity only)
 */
export function useViewNavigate() {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  return useCallback(
    (to: string, options?: { replace?: boolean; state?: unknown }) => {
      const fromDoc = pathname.startsWith("/doc");
      const toDoc = to.startsWith("/doc");

      let transition: TransitionType;
      if (fromDoc && toDoc) {
        transition = "doc-slide";
      } else if (toDoc) {
        transition = "depth-down";
      } else if (fromDoc) {
        transition = "depth-up";
      } else {
        transition = "crossfade";
      }

      document.documentElement.dataset.transition = transition;
      navigate(to, { ...options, viewTransition: true });
    },
    [navigate, pathname],
  );
}
