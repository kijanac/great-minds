import { useEffect, useState } from "react"

import { listSessions, type SessionSummary } from "@/api/sessions"

export function useSessions() {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    listSessions()
      .then(setSessions)
      .catch(() => setSessions([]))
      .finally(() => setLoading(false))
  }, [])

  return { sessions, loading }
}
