import { useQuery } from "@tanstack/react-query";

import { fetchLintResults } from "@/api/explore";
import { useActiveBrainId } from "@/hooks/use-brain";

export function useExploreBadge() {
  const brainId = useActiveBrainId();
  return useQuery({
    queryKey: ["brain", brainId, "explore-count"],
    queryFn: fetchLintResults,
    enabled: !!brainId,
  });
}
