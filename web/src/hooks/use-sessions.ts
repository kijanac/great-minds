import { useQuery } from "@tanstack/react-query";

import { listSessions } from "@/api/sessions";
import { useActiveVaultId } from "@/hooks/use-vault";

export function useSessions() {
  const vaultId = useActiveVaultId();
  return useQuery({
    queryKey: ["vault", vaultId, "sessions"],
    queryFn: () => listSessions(),
    enabled: !!vaultId,
  });
}
