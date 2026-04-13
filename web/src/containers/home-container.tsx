import { useCallback, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Home } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ErrorState, Spinner } from "@/components/ui/feedback";
import { FirstRun } from "@/containers/first-run";
import { IngestionContainer } from "@/containers/ingestion-container";
import { ProjectSwitcher } from "@/containers/project-switcher";
import { SearchBar } from "@/components/search-bar";
import { SessionThread } from "@/containers/session-thread";
import { useActiveBrain } from "@/hooks/use-brain";
import { useExploreBadge } from "@/hooks/use-explore-badge";
import { useSavedSession } from "@/hooks/use-saved-session";
import { useSession } from "@/hooks/use-session";
import { useSessions } from "@/hooks/use-sessions";
import { useViewNavigate } from "@/hooks/use-view-navigate";
import type { Exchange } from "@/lib/types";

interface HomeContainerProps {
  sessionId?: string;
  initialQuery?: string;
  origin?: string;
}

export function HomeContainer({ sessionId, initialQuery, origin }: HomeContainerProps) {
  const brains = useActiveBrain();
  const saved = useSavedSession(sessionId ?? null);

  if (brains.error) {
    return (
      <ErrorState
        message="Couldn't load your projects."
        onRetry={() => brains.refetch()}
      />
    );
  }

  if (brains.isLoading) return <Spinner label="Loading…" />;

  if ((brains.data?.length ?? 0) === 0 && !sessionId) {
    return <FirstRun />;
  }

  if (sessionId) {
    if (saved.error) {
      return (
        <ErrorState
          message="Couldn't load this session."
          onRetry={() => saved.refetch()}
        />
      );
    }
    if (saved.isLoading) return <Spinner label="Loading session…" />;
  }

  return (
    <HomeContent
      sessionId={sessionId}
      initialExchanges={saved.data ?? undefined}
      initialQuery={initialQuery}
      origin={origin}
    />
  );
}

interface HomeContentProps {
  sessionId?: string;
  initialExchanges?: Exchange[];
  initialQuery?: string;
  origin?: string;
}

const EASE_OUT: [number, number, number, number] = [0.25, 1, 0.5, 1];

function HomeContent({ sessionId, initialExchanges, initialQuery, origin }: HomeContentProps) {
  const navigate = useViewNavigate();
  const { activeBrain } = useActiveBrain();
  const badge = useExploreBadge();
  const badgeCount = badge.data?.research_suggestions.length ?? 0;
  const [query, setQuery] = useState(initialQuery ?? initialExchanges?.[0]?.query ?? "");
  const sessions = useSessions();

  const handleSessionCreated = useCallback(
    (sid: string) => {
      window.history.replaceState(null, "", `/sessions/${sid}`);
      sessions.refetch();
    },
    [sessions],
  );

  const session = useSession(
    initialExchanges
      ? { initialExchanges, sessionId: sessionId! }
      : initialQuery || origin
        ? { initialQuery, originPath: origin, onSessionCreated: handleSessionCreated }
        : { onSessionCreated: handleSessionCreated },
  );

  const isActive = session.phase !== "idle";
  const prefersReducedMotion = useReducedMotion();
  const shouldAnimate = !prefersReducedMotion;

  const barTransition = prefersReducedMotion ? { duration: 0 } : { duration: 0.28, ease: EASE_OUT };
  const fadeIn = prefersReducedMotion ? { duration: 0 } : { duration: 0.15 };
  const fadeOut = prefersReducedMotion ? { duration: 0 } : { duration: 0.15, ease: EASE_OUT };

  const { submitQuery } = session;
  const handleSubmit = useCallback(() => {
    if (!query.trim()) return;
    submitQuery(query);
  }, [query, submitQuery]);

  const searchBarProps = {
    query,
    phase: session.phase,
    onQueryChange: setQuery,
    onSubmit: handleSubmit,
  };

  return (
    <div className="flex h-screen overflow-hidden relative">
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {isActive && (
          <div className="shrink-0 px-4 md:px-10 pt-[22px] pb-[18px] border-b border-ink-subtle">
            <motion.div
              className="w-full flex items-center gap-3"
              layoutId="search-bar"
              transition={barTransition}
            >
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => navigate("/")}
                aria-label="home"
                className="text-muted-foreground hover:text-gold hover:bg-transparent shrink-0"
              >
                <Home size={14} />
              </Button>
              <div className="flex-1 min-w-0">
                <SearchBar {...searchBarProps} />
              </div>
            </motion.div>
          </div>
        )}

        <AnimatePresence initial={false}>
          {!isActive && (
            <motion.div
              key="home-content"
              className="flex-1 flex flex-col items-center justify-center px-4 md:px-10 pb-12"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, transition: fadeOut }}
              transition={fadeIn}
            >
              <div className="mb-6 flex items-center gap-1.5">
                {activeBrain && (
                  <Button
                    variant="outline"
                    onClick={() => navigate("/explore")}
                    className="h-auto py-1.5 px-4 rounded-sm border-ink-border font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-warm-faint hover:text-warm hover:border-gold-dim gap-2.5"
                  >
                    {activeBrain.name}
                    {badgeCount > 0 && (
                      <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-gold/20 text-gold text-[10px] leading-none">
                        {badgeCount}
                      </span>
                    )}
                  </Button>
                )}
                <ProjectSwitcher />
              </div>

              <motion.div
                className="w-full max-w-[640px] flex items-center gap-3"
                layoutId="search-bar"
                transition={barTransition}
              >
                <div className="flex-1 min-w-0">
                  <SearchBar
                    {...searchBarProps}
                    recentSessions={sessions.data ?? []}
                    sessionsLoading={sessions.isLoading}
                    onSessionClick={(id) => navigate(`/sessions/${id}`)}
                    onViewAllSessions={() => navigate("/sessions")}
                  />
                </div>
              </motion.div>

              <IngestionContainer />
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence initial={false}>
          {isActive && (
            <motion.div
              key="session-thread"
              className="flex-1 min-h-0 overflow-hidden flex flex-col"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, transition: { duration: 0 } }}
              transition={
                shouldAnimate ? { duration: 0.2, delay: 0.1, ease: EASE_OUT } : { duration: 0 }
              }
            >
              <SessionThread session={session} onFollowUp={session.submitFollowUp} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
