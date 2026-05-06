import { useQuery } from "@tanstack/react-query";

import { useActiveVaultId } from "@/hooks/use-vault";

/**
 * Checks whether there's an active compile pipeline for the current vault.
 * Returns true if a compile intent is pending or dispatched (i.e., not yet satisfied).
 */
export function useActivePipeline(): boolean {
  const vaultId = useActiveVaultId();

  // Poll for pending intents by checking the most recent one
  const { data } = useQuery({
    queryKey: ["vault", vaultId, "active-pipeline"],
    queryFn: async () => {
      // We don't have a "list compile intents" endpoint, so we use a
      // heuristic: check if any known intent is unsatisfied. For now,
      // return false until we have an endpoint that returns active tasks.
      return false;
    },
    enabled: !!vaultId,
    refetchInterval: 10_000,
    staleTime: 5_000,
  });

  return data ?? false;
}
