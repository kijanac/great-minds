import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import {
  type BrainOverview,
  createBrain as apiCreateBrain,
  fetchBrains,
  getBrainId,
  storeBrainId,
} from "@/api/client";

function subscribe(callback: () => void) {
  window.addEventListener("storage", callback);
  return () => window.removeEventListener("storage", callback);
}

function getSnapshot(): string | null {
  return getBrainId();
}

export function useBrain() {
  const activeBrainId = useSyncExternalStore(subscribe, getSnapshot);
  const [brains, setBrains] = useState<BrainOverview[]>([]);

  useEffect(() => {
    fetchBrains().then(setBrains).catch(() => setBrains([]));
  }, []);

  const switchBrain = useCallback(
    (brainId: string) => {
      if (brainId === activeBrainId) return;
      storeBrainId(brainId);
    },
    [activeBrainId],
  );

  const createBrain = useCallback(async (name: string) => {
    const brain = await apiCreateBrain(name);
    setBrains((prev) => [...prev, brain]);
    storeBrainId(brain.id);
    return brain;
  }, []);

  const activeBrain = brains.find((b) => b.id === activeBrainId) ?? null;

  return { brains, activeBrain, activeBrainId, switchBrain, createBrain };
}
