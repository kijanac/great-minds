import { useCallback, useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  type BrainOverview,
  type CreateBrainInput,
  createBrain as apiCreateBrain,
  fetchBrains,
  getBrainId,
  storeBrainId,
} from "@/api/client";

function subscribeBrainId(cb: () => void) {
  window.addEventListener("auth:changed", cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener("auth:changed", cb);
    window.removeEventListener("storage", cb);
  };
}

export function useActiveBrainId(): string | null {
  return useSyncExternalStore(subscribeBrainId, getBrainId);
}

export function useBrains() {
  return useQuery({
    queryKey: ["brains"],
    queryFn: fetchBrains,
  });
}

export function useActiveBrain() {
  const brains = useBrains();
  const activeBrainId = useActiveBrainId();
  const activeBrain = brains.data?.find((b) => b.id === activeBrainId) ?? null;
  return { ...brains, activeBrain, activeBrainId };
}

export function useCreateBrain() {
  const qc = useQueryClient();
  return useMutation<BrainOverview, Error, CreateBrainInput>({
    mutationFn: async (input) => {
      const brain = await apiCreateBrain(input);
      storeBrainId(brain.id);
      return brain;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["brains"] });
    },
  });
}

export function useSwitchBrain() {
  const qc = useQueryClient();
  return useCallback(
    (brainId: string) => {
      if (brainId === getBrainId()) return;
      storeBrainId(brainId);
      qc.invalidateQueries({ queryKey: ["brain"] });
    },
    [qc],
  );
}
