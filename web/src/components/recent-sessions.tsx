import { Button } from "@/components/ui/button"
import type { SessionSummary } from "@/api/sessions"
import { formatRelativeDate } from "@/lib/utils"

interface RecentSessionsProps {
  sessions: SessionSummary[]
  onSessionClick: (id: string) => void
  onViewAll: () => void
}

export function RecentSessions({
  sessions,
  onSessionClick,
  onViewAll,
}: RecentSessionsProps) {
  if (sessions.length === 0) return null

  const recent = sessions.slice(0, 4)

  return (
    <div className="mt-10 max-w-[640px] w-full">
      <div className="space-y-1">
        {recent.map((s) => (
          <Button
            key={s.id}
            variant="ghost"
            onClick={() => onSessionClick(s.id)}
            className="w-full justify-between h-auto py-1.5 px-2 rounded-sm hover:bg-ink-raised group"
          >
            <span className="font-serif italic text-[length:var(--text-small)] text-warm-ghost group-hover:text-warm-faint transition-colors truncate text-left">
              {s.query}
            </span>
            <span className="font-mono text-[length:var(--text-chrome)] text-muted-foreground shrink-0 ml-3">
              {formatRelativeDate(s.updated)}
            </span>
          </Button>
        ))}
      </div>

      {sessions.length > 4 && (
        <Button
          variant="ghost"
          onClick={onViewAll}
          className="mt-2 h-auto py-1 px-2 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-muted-foreground hover:text-gold hover:bg-transparent"
        >
          all sessions
        </Button>
      )}
    </div>
  )
}
