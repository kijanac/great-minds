import { useNavigate } from "react-router";

import { SessionList } from "@/components/session-list";
import { useSessions } from "@/hooks/use-sessions";

export function SessionsContainer() {
  const navigate = useNavigate();
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
