import { useCallback, useState } from "react"
import { useNavigate } from "react-router"

import { RecentSessions } from "@/components/recent-sessions"
import { SearchBar } from "@/components/search-bar"
import { SessionThread } from "@/containers/session-thread"
import { useSession } from "@/hooks/use-session"
import { useSessions } from "@/hooks/use-sessions"

export function HomeContainer() {
  const navigate = useNavigate()
  const [query, setQuery] = useState("")
  const session = useSession()
  const { sessions: recentSessions } = useSessions()

  const isActive = session.phase !== "idle"

  const handleSubmit = useCallback(() => {
    if (!query.trim()) return
    session.submitQuery(query)
  }, [query, session.submitQuery])

  const handleReset = useCallback(() => {
    session.reset()
    setQuery("")
  }, [session.reset])

  return (
    <div className="flex h-screen overflow-hidden relative">
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        <SearchBar
          query={query}
          phase={session.phase}
          onQueryChange={setQuery}
          onSubmit={handleSubmit}
          onReset={handleReset}
        />

        {!isActive && (
          <div className="flex justify-center -mt-16">
            <RecentSessions
              sessions={recentSessions}
              onSessionClick={(id) => navigate(`/sessions/${id}`)}
              onViewAll={() => navigate("/sessions")}
            />
          </div>
        )}

        {isActive && (
          <SessionThread
            session={session}
            onFollowUp={session.submitFollowUp}
          />
        )}
      </div>
    </div>
  )
}
