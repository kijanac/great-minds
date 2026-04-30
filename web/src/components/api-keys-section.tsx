import { useState } from "react";
import { Check, Copy, X } from "lucide-react";

import type { ApiKey, ApiKeyCreated } from "@/api/api-keys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatShortDate } from "@/lib/utils";

interface ApiKeysSectionProps {
  keys: ApiKey[];
  justCreated: ApiKeyCreated | null;
  creating: boolean;
  loading: boolean;
  onCreate: (label: string) => Promise<void>;
  onRevoke: (keyId: string) => Promise<void>;
  onDismissCreated: () => void;
}

export function ApiKeysSection({
  keys,
  justCreated,
  creating,
  loading,
  onCreate,
  onRevoke,
  onDismissCreated,
}: ApiKeysSectionProps) {
  const [label, setLabel] = useState("");
  const [copied, setCopied] = useState(false);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = label.trim();
    if (!trimmed || creating) return;
    await onCreate(trimmed);
    setLabel("");
  }

  async function handleCopy(text: string) {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const active = keys.filter((k) => !k.revoked);
  const revoked = keys.filter((k) => k.revoked);

  return (
    <div className="mt-12">
      <h2 className="font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-gold-muted uppercase mb-4">
        api keys
      </h2>

      {justCreated && (
        <div className="mb-6 p-4 rounded-sm bg-gold/10 border border-gold-dim">
          <div className="flex items-start justify-between gap-3 mb-3">
            <div className="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-gold">
              new key — copy now, it won't be shown again
            </div>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onDismissCreated}
              className="text-warm-ghost hover:text-warm shrink-0"
            >
              <X size={12} />
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 font-mono text-[length:var(--text-small)] text-warm bg-ink-raised px-3 py-2 rounded-sm break-all">
              {justCreated.raw_key}
            </code>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => handleCopy(justCreated.raw_key)}
              className="text-warm-ghost hover:text-gold shrink-0"
              aria-label="copy"
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </Button>
          </div>
        </div>
      )}

      {loading && keys.length === 0 ? (
        <p className="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost">
          loading…
        </p>
      ) : keys.length === 0 ? (
        <p className="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost mb-4">
          no api keys yet
        </p>
      ) : (
        <div className="space-y-1 mb-4">
          {active.map((k) => (
            <div
              key={k.id}
              className="flex items-center justify-between py-2 px-3 rounded-sm hover:bg-ink-raised group"
            >
              <span className="font-mono text-[length:var(--text-small)] text-warm-dim truncate">
                {k.label}
              </span>
              <div className="flex items-center gap-3">
                <span className="font-mono text-[length:var(--text-chrome)] text-warm-ghost shrink-0">
                  {formatShortDate(k.created_at)}
                </span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => onRevoke(k.id)}
                  className="text-warm-ghost hover:text-red-400 hover:bg-transparent opacity-0 group-hover:opacity-100 transition-opacity"
                  aria-label="revoke"
                >
                  <X size={12} />
                </Button>
              </div>
            </div>
          ))}
          {revoked.length > 0 && (
            <details className="mt-2">
              <summary className="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost cursor-pointer hover:text-warm-faint py-1">
                {revoked.length} revoked
              </summary>
              <div className="mt-1 space-y-1">
                {revoked.map((k) => (
                  <div
                    key={k.id}
                    className="flex items-center justify-between py-2 px-3 rounded-sm opacity-60"
                  >
                    <span className="font-mono text-[length:var(--text-small)] text-warm-ghost truncate line-through">
                      {k.label}
                    </span>
                    <span className="font-mono text-[length:var(--text-chrome)] text-warm-ghost shrink-0">
                      {formatShortDate(k.created_at)}
                    </span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      <form onSubmit={handleCreate} className="flex items-center gap-3">
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="new key label"
          disabled={creating}
          className="h-8 bg-transparent dark:bg-transparent border-ink-border rounded-sm font-mono text-[length:var(--text-small)] text-warm px-3 caret-gold placeholder:text-warm-ghost focus-visible:ring-0 focus-visible:border-gold-dim"
        />
        <span className="font-mono text-[length:var(--text-chrome)] text-warm-ghost shrink-0">
          ↵
        </span>
      </form>
    </div>
  );
}
