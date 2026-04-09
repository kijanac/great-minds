import { useEffect, useState, useSyncExternalStore } from "react";

import { getBrainId } from "@/api/client";
import { fetchLintResults } from "@/api/explore";

function subscribe(cb: () => void) {
  window.addEventListener("storage", cb);
  return () => window.removeEventListener("storage", cb);
}

export function useExploreBadge() {
  const brainId = useSyncExternalStore(subscribe, getBrainId);
  const [count, setCount] = useState(0);

  useEffect(() => {
    fetchLintResults()
      .then((lint) => setCount(lint.research_suggestions.length))
      .catch(() => setCount(0));
  }, [brainId]);

  return count;
}
