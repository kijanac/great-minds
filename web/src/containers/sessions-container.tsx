import { SessionList } from "@/components/session-list";
import { useSessions } from "@/hooks/use-sessions";
import { useViewNavigate } from "@/hooks/use-view-navigate";

export function SessionsContainer() {
  const navigate = useViewNavigate();
  const { sessions, loading } = useSessions();

  return (
    <SessionList
      sessions={sessions}
      loading={loading}
      onSessionClick={(id) => navigate(`/sessions/${id}`)}
      onHome={() => navigate("/")}
    />
  );
}
