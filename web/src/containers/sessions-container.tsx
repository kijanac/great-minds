import { SessionList } from "@/components/session-list";
import { useSessions } from "@/hooks/use-sessions";
import { useViewNavigate } from "@/hooks/use-view-navigate";

export function SessionsContainer() {
  const navigate = useViewNavigate();
  const { data, isLoading, error, refetch } = useSessions();

  return (
    <SessionList
      sessions={data ?? []}
      loading={isLoading}
      error={error}
      onRetry={() => refetch()}
      onSessionClick={(id) => navigate(`/sessions/${id}`)}
      onHome={() => navigate("/")}
    />
  );
}
