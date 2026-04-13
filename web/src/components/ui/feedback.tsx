import { Button } from "@/components/ui/button";

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex h-full w-full items-center justify-center py-10">
      <p className="text-[length:var(--text-body)] text-warm-faint animate-[pulse-fade_1.6s_ease-in-out_infinite]">
        {label}
      </p>
    </div>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex h-full w-full items-center justify-center py-10 px-4">
      <p className="text-[length:var(--text-body)] text-warm-ghost text-center">{message}</p>
    </div>
  );
}

interface ErrorStateProps {
  message?: string;
  onRetry?: () => void;
}

export function ErrorState({
  message = "Something went wrong.",
  onRetry,
}: ErrorStateProps) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 py-10 px-4">
      <p className="font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-warm-faint text-center">
        {message}
      </p>
      {onRetry && (
        <Button
          variant="outline"
          size="sm"
          onClick={onRetry}
          className="font-mono text-[length:var(--text-chrome)] tracking-[0.1em]"
        >
          retry
        </Button>
      )}
    </div>
  );
}
