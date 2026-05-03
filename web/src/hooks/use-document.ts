import { useQuery } from "@tanstack/react-query";

import { readDocument } from "@/api/doc";
import { useActiveVaultId } from "@/hooks/use-vault";

export function useDocument(path: string | null) {
  const vaultId = useActiveVaultId();
  return useQuery({
    queryKey: ["vault", vaultId, "doc", path],
    queryFn: ({ signal }) => readDocument(path!, signal),
    enabled: !!path && !!vaultId,
  });
}
