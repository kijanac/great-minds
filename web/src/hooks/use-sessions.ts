import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { getBrainId } from "@/api/client";
import { listSessions, type SessionSummary } from "@/api/sessions";

function subscribe(cb: () => void) {
  window.addEventListener("storage", cb);
  return () => window.removeEventListener("storage", cb);
}

export function useSessions() {
  const brainId = useSyncExternalStore(subscribe, getBrainId);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    listSessions()
      .then(setSessions)
      .catch(() => setSessions([]));
  }, []);

  useEffect(() => {
    setLoading(true);
    listSessions()
      .then(setSessions)
      .catch(() => setSessions([]))
      .finally(() => setLoading(false));
  }, [brainId]);

  return { sessions, loading, refresh };
}
