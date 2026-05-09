import { useState } from "react";

import { draftThematicHint } from "@/api/vaults";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export interface VaultConfigFormSubmit {
  name?: string;
  thematic_hint: string;
}

interface VaultConfigFormProps {
  mode: "create" | "edit";
  initialName?: string;
  initialThematicHint?: string;
  submitting?: boolean;
  onSubmit: (data: VaultConfigFormSubmit) => Promise<void> | void;
  onCancel?: () => void;
  submitLabel?: string;
}

const SECTION_LABEL =
  "font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-gold-muted uppercase mb-2 block";

const HELPER_TEXT = "font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost";

export function VaultConfigForm({
  mode,
  initialName = "",
  initialThematicHint = "",
  submitting = false,
  onSubmit,
  onCancel,
  submitLabel,
}: VaultConfigFormProps) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState("");
  const [thematicHint, setThematicHint] = useState(initialThematicHint);
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);

  const isCreate = mode === "create";
  const canSubmit = !submitting && (!isCreate || name.trim().length > 0);

  async function handleDraft() {
    const trimmed = description.trim();
    if (!trimmed || drafting) return;
    setDraftError(null);
    setDrafting(true);
    try {
      const hint = await draftThematicHint(trimmed);
      setThematicHint(hint);
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : "Failed to draft");
    } finally {
      setDrafting(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    await onSubmit({
      name: isCreate ? name.trim() : undefined,
      thematic_hint: thematicHint,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-8">
      {isCreate && (
        <div>
          <Label htmlFor="vault-name" className={SECTION_LABEL}>
            project name
          </Label>
          <Input
            id="vault-name"
            autoFocus
            disabled={submitting}
            placeholder="untitled"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-auto border-input rounded-sm bg-secondary dark:bg-secondary font-serif text-[length:var(--text-body)] text-foreground px-[14px] py-[10px] caret-gold placeholder:text-warm-ghost focus-visible:ring-0 focus-visible:border-ring disabled:opacity-60"
          />
        </div>
      )}

      <div>
        <Label htmlFor="vault-description" className={SECTION_LABEL}>
          describe what to focus on
          <span className="ml-2 text-warm-ghost normal-case tracking-normal">
            (optional, used to draft a focus statement)
          </span>
        </Label>
        <Textarea
          id="vault-description"
          disabled={submitting || drafting}
          placeholder="e.g. a knowledge base on Marxist political economy, with emphasis on debates and events over biography"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          className="rounded-sm font-serif text-[length:var(--text-body)] text-foreground placeholder:text-warm-ghost focus-visible:ring-0"
        />
        <div className="mt-2 flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleDraft}
            disabled={!description.trim() || drafting || submitting}
            className="font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-warm-faint hover:text-gold border-ink-border hover:border-gold-dim"
          >
            {drafting ? "drafting…" : "draft focus from description"}
          </Button>
          {draftError && (
            <Alert
              variant="destructive"
              className="rounded-sm border-red-400/25 bg-red-400/5 py-1.5"
            >
              <AlertDescription className="font-mono text-[length:var(--text-chrome)] text-red-400/90">
                {draftError}
              </AlertDescription>
            </Alert>
          )}
        </div>
      </div>

      <div>
        <Label htmlFor="vault-thematic-hint" className={SECTION_LABEL}>
          editorial focus
          <span className="ml-2 text-warm-ghost normal-case tracking-normal">
            (steers how topics are framed; leave blank to use defaults)
          </span>
        </Label>
        <Textarea
          id="vault-thematic-hint"
          disabled={submitting}
          placeholder="prefer event-centric and debate-centric framings over biographical summaries"
          value={thematicHint}
          onChange={(e) => setThematicHint(e.target.value)}
          rows={5}
          className="rounded-sm font-serif text-[length:var(--text-body)] text-foreground placeholder:text-warm-ghost focus-visible:ring-0"
        />
        <p className={`${HELPER_TEXT} mt-2`}>
          this text is prepended to the canonicalize prompt during compile.
        </p>
      </div>

      <div className="flex items-center gap-3 pt-2">
        <Button
          type="submit"
          disabled={!canSubmit}
          className="rounded-sm bg-gold/15 text-gold border border-gold-dim hover:bg-gold/25 font-mono text-[length:var(--text-chrome)] tracking-[0.1em]"
        >
          {submitting ? "saving…" : (submitLabel ?? (isCreate ? "create project" : "save changes"))}
        </Button>
        {onCancel && (
          <Button
            type="button"
            variant="ghost"
            onClick={onCancel}
            disabled={submitting}
            className="font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-warm-ghost hover:text-warm hover:bg-transparent"
          >
            cancel
          </Button>
        )}
      </div>
    </form>
  );
}
