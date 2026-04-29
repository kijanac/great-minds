import { useState } from "react";

import { draftThematicHint } from "@/api/brains";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface BrainConfigFormSubmit {
  name?: string;
  thematic_hint: string;
}

interface BrainConfigFormProps {
  mode: "create" | "edit";
  initialName?: string;
  initialThematicHint?: string;
  submitting?: boolean;
  onSubmit: (data: BrainConfigFormSubmit) => Promise<void> | void;
  onCancel?: () => void;
  submitLabel?: string;
}

const TEXTAREA_CLASS =
  "w-full bg-secondary border border-input focus-within:border-ring rounded-sm px-[14px] py-[10px] font-serif text-[length:var(--text-body)] text-foreground placeholder:text-warm-ghost outline-none resize-y min-h-[120px] caret-gold";

const SECTION_LABEL =
  "font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-gold-muted uppercase mb-2 block";

const HELPER_TEXT =
  "font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost";

export function BrainConfigForm({
  mode,
  initialName = "",
  initialThematicHint = "",
  submitting = false,
  onSubmit,
  onCancel,
  submitLabel,
}: BrainConfigFormProps) {
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
          <label htmlFor="brain-name" className={SECTION_LABEL}>
            project name
          </label>
          <Input
            id="brain-name"
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
        <label htmlFor="brain-description" className={SECTION_LABEL}>
          describe what to focus on
          <span className="ml-2 text-warm-ghost normal-case tracking-normal">
            (optional, used to draft a focus statement)
          </span>
        </label>
        <textarea
          id="brain-description"
          disabled={submitting || drafting}
          placeholder="e.g. a knowledge base on Marxist political economy, with emphasis on debates and events over biography"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          className={TEXTAREA_CLASS}
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
            <span className="font-mono text-[length:var(--text-chrome)] text-red-400">
              {draftError}
            </span>
          )}
        </div>
      </div>

      <div>
        <label htmlFor="brain-thematic-hint" className={SECTION_LABEL}>
          editorial focus
          <span className="ml-2 text-warm-ghost normal-case tracking-normal">
            (steers how topics are framed; leave blank to use defaults)
          </span>
        </label>
        <textarea
          id="brain-thematic-hint"
          disabled={submitting}
          placeholder="prefer event-centric and debate-centric framings over biographical summaries"
          value={thematicHint}
          onChange={(e) => setThematicHint(e.target.value)}
          rows={5}
          className={TEXTAREA_CLASS}
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
