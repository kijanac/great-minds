import { useQuery } from "@tanstack/react-query";

import { listSessions } from "@/api/sessions";
import { useActiveBrainId } from "@/hooks/use-brain";

export function useSessions() {
  const brainId = useActiveBrainId();
  return useQuery({
    queryKey: ["brain", brainId, "sessions"],
    queryFn: () => listSessions(),
    enabled: !!brainId,
  });
}
