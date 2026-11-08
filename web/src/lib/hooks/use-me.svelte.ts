import { createQuery } from "@tanstack/svelte-query";

import { fetchMe } from "#lib/api/auth.ts";
import { auth } from "#lib/auth.svelte.ts";

export const unsponsoredNotice =
  "This account can read but can't ask or add documents. Ask whoever runs this Great Minds server to sponsor it.";

export function useMe() {
  const me = createQuery(() => ({
    queryKey: ["me", auth.userId],
    queryFn: ({ signal }) => fetchMe(signal),
    enabled: auth.isAuthenticated,
    staleTime: 5 * 60 * 1000,
  }));
  return {
    get canUseModels() {
      return me.data?.can_use_models ?? true;
    },
  };
}
