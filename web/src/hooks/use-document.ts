import { useQuery } from "@tanstack/react-query";

import { readDocument } from "@/api/doc";
import { useActiveBrainId } from "@/hooks/use-brain";

export function useDocument(path: string | null) {
  const brainId = useActiveBrainId();
  return useQuery({
    queryKey: ["brain", brainId, "doc", path],
    queryFn: ({ signal }) => readDocument(path!, signal),
    enabled: !!path && !!brainId,
  });
}
