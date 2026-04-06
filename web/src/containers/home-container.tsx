import { useCallback, useState } from "react"
import { useNavigate } from "react-router"

import { IngestionContainer } from "@/containers/ingestion-container"
import { RecentSessions } from "@/components/recent-sessions"
import { SearchBar } from "@/components/search-bar"
import { SessionThread } from "@/containers/session-thread"
import { useSavedSession } from "@/hooks/use-saved-session"
import { useSession } from "@/hooks/use-session"
import { useSessions } from "@/hooks/use-sessions"

interface HomeContainerProps {
  sessionId?: string
}

export function HomeContainer({ sessionId }: HomeContainerProps) {
  const { exchanges, loading } = useSavedSession(sessionId ?? null)

  // Wait for saved session to load before rendering
  if (sessionId && loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <p className="text-[length:var(--text-body)] text-warm-faint animate-[pulse-fade_1.6s_ease-in-out_infinite]">
          Loading session...
        </p>
      </div>
    )
  }

  return (
    <HomeContent
      sessionId={sessionId}
      initialExchanges={exchanges ?? undefined}
    />
  )
}

interface HomeContentProps {
  sessionId?: string
  initialExchanges?: ReturnType<typeof useSavedSession>["exchanges"] & {}
}

function HomeContent({ sessionId, initialExchanges }: HomeContentProps) {
  const navigate = useNavigate()
  const [query, setQuery] = useState("")
  const session = useSession(
    initialExchanges
      ? { initialExchanges, sessionId: sessionId! }
      : undefined,
  )
  const { sessions: recentSessions } = useSessions()

  const isActive = session.phase !== "idle"

  const handleSubmit = useCallback(() => {
    if (!query.trim()) return
    session.submitQuery(query)
  }, [query, session.submitQuery])

  const handleReset = useCallback(() => {
    session.reset()
    setQuery("")
    if (sessionId) navigate("/")
  }, [session.reset, sessionId, navigate])

  return (
    <div className="flex h-screen overflow-hidden relative">
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {isActive ? (
          <div className="shrink-0 px-10 pt-[22px] pb-[18px] border-b border-ink-subtle">
            <SearchBar
              query={query}
              phase={session.phase}
              onQueryChange={setQuery}
              onSubmit={handleSubmit}
              onReset={handleReset}
            />
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center px-10 pb-12">
            <div className="font-mono text-[length:var(--text-chrome)] tracking-[0.26em] uppercase text-gold-muted mb-10">
              ARCHIVE — KNOWLEDGE BASE
            </div>

            <SearchBar
              query={query}
              phase={session.phase}
              onQueryChange={setQuery}
              onSubmit={handleSubmit}
              onReset={handleReset}
            />

            <RecentSessions
              sessions={recentSessions}
              onSessionClick={(id) => navigate(`/sessions/${id}`)}
              onViewAll={() => navigate("/sessions")}
            />

            <IngestionContainer />
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
