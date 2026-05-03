import { useQuery } from "@tanstack/react-query";

import { fetchLintResults } from "@/api/explore";
import { useActiveVaultId } from "@/hooks/use-vault";

export function useExploreBadge() {
  const vaultId = useActiveVaultId();
  return useQuery({
    queryKey: ["vault", vaultId, "explore-count"],
    queryFn: fetchLintResults,
    enabled: !!vaultId,
  });
}
