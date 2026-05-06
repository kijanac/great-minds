import { useQuery } from "@tanstack/react-query";

import { getCompileIntent, type CompileIntent } from "@/api/compile";
import { useActiveVaultId } from "@/hooks/use-vault";

/** Fetches a single CompileIntent snapshot. Pipeline progress streams over SSE. */
export function useCompileIntent(intentId: string | null) {
  const vaultId = useActiveVaultId();
  return useQuery<CompileIntent>({
    queryKey: ["vault", vaultId, "compile-intent", intentId],
    queryFn: () => getCompileIntent(intentId!),
    enabled: !!vaultId && !!intentId,
  });
}
