import { useQuery } from "@tanstack/react-query";

import { getCompileIntent, type CompileIntent } from "@/api/compile";
import { useActiveVaultId } from "@/hooks/use-vault";

const POLL_MS = 2000;

/** Polls a single CompileIntent until it reaches `satisfied`. */
export function useCompileIntent(intentId: string | null) {
  const vaultId = useActiveVaultId();
  return useQuery<CompileIntent>({
    queryKey: ["vault", vaultId, "compile-intent", intentId],
    queryFn: () => getCompileIntent(intentId!),
    enabled: !!vaultId && !!intentId,
    refetchInterval: (query) => {
      const data = query.state.data;
      return data?.status === "satisfied" ? false : POLL_MS;
    },
  });
}
