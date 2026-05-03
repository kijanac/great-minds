import { useCallback, useEffect, useState } from "react";

import { listSessions, type SessionSummary } from "@/api/sessions";
import { SessionList } from "@/components/session-list";
import { useActiveVaultId } from "@/hooks/use-vault";
import { useViewNavigate } from "@/hooks/use-view-navigate";

const PAGE_SIZE = 50;

export function SessionsContainer() {
  const navigate = useViewNavigate();
  const vaultId = useActiveVaultId();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(
    async (nextOffset: number, append: boolean) => {
      if (!vaultId) return;
      setLoading(true);
      setError(null);
      try {
        const result = await listSessions({
          limit: PAGE_SIZE,
          offset: nextOffset,
        });
        setSessions((prev) =>
          append ? [...prev, ...result.items] : result.items,
        );
        setTotal(result.pagination.total);
        setOffset(result.pagination.offset);
      } catch (err) {
        setError(err instanceof Error ? err : new Error("Failed to load sessions"));
        if (!append) {
          setSessions([]);
          setTotal(0);
          setOffset(0);
        }
      } finally {
        setLoading(false);
      }
    },
    [vaultId],
  );

  useEffect(() => {
    load(0, false);
  }, [load]);

  const hasMore = sessions.length < total;

  return (
    <SessionList
      sessions={sessions}
      loading={loading}
      error={error}
      hasMore={hasMore}
      onRetry={() => load(0, false)}
      onSessionClick={(id) => navigate(`/sessions/${id}`)}
      onHome={() => navigate("/")}
      onLoadMore={() => load(offset + PAGE_SIZE, true)}
    />
  );
}
