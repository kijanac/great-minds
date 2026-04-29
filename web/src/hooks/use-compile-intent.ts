import { useQuery } from "@tanstack/react-query";

import { getCompileIntent, type CompileIntent } from "@/api/compile";
import { useActiveBrainId } from "@/hooks/use-brain";

const POLL_MS = 2000;

/** Polls a single CompileIntent until it reaches `satisfied`. */
export function useCompileIntent(intentId: string | null) {
  const brainId = useActiveBrainId();
  return useQuery<CompileIntent>({
    queryKey: ["brain", brainId, "compile-intent", intentId],
    queryFn: () => getCompileIntent(intentId!),
    enabled: !!brainId && !!intentId,
    refetchInterval: (query) => {
      const data = query.state.data;
      return data?.status === "satisfied" ? false : POLL_MS;
    },
  });
}
