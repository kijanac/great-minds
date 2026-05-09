import { useEffect, useState } from "react";

import type { UserSuggestionIntent } from "@/api/ingest";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export interface SuggestionPayload {
  body: string;
  intent: UserSuggestionIntent;
}

interface SuggestionFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchoredTo: string;
  anchoredSection: string;
  onSubmit: (payload: SuggestionPayload) => Promise<void>;
}

const INTENT_OPTIONS: {
  value: UserSuggestionIntent;
  label: string;
  hint: string;
}[] = [
  {
    value: "disagree",
    label: "disagree",
    hint: "You think the article is wrong about this.",
  },
  {
    value: "correct",
    label: "correct",
    hint: "A factual correction or precise refinement.",
  },
  {
    value: "add_context",
    label: "add context",
    hint: "More evidence, background, or a related angle.",
  },
  {
    value: "restructure",
    label: "restructure",
    hint: "Scope, granularity, or organization feels off.",
  },
];

export function SuggestionForm({
  open,
  onOpenChange,
  anchoredTo,
  anchoredSection,
  onSubmit,
}: SuggestionFormProps) {
  const [intent, setIntent] = useState<UserSuggestionIntent>("add_context");
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const reset = window.setTimeout(() => {
      setIntent("add_context");
      setBody("");
      setError(null);
      setSubmitting(false);
    }, 0);
    return () => window.clearTimeout(reset);
  }, [open]);

  const canSubmit = body.trim().length > 0 && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({ body: body.trim(), intent });
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to submit suggestion.");
      setSubmitting(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85vh] border-t border-ink-subtle">
        <SheetHeader className="px-6 pt-6 pb-2">
          <SheetTitle className="font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-gold-muted uppercase">
            suggest · {anchoredTo}
          </SheetTitle>
          <SheetDescription className="font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-warm-ghost">
            Your suggestion enters the pipeline as a source document and influences the next
            compile.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-6">
          <div className="max-w-[680px] mx-auto space-y-5">
            {anchoredSection && (
              <blockquote className="border-l-2 border-gold-dim pl-4 text-warm-faint italic font-serif text-[length:var(--text-body)]">
                {anchoredSection}
              </blockquote>
            )}

            <div className="space-y-2">
              <p className="font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-warm-ghost uppercase">
                intent
              </p>
              <ToggleGroup
                multiple={false}
                value={[intent]}
                onValueChange={(vals) => vals[0] && setIntent(vals[0] as UserSuggestionIntent)}
                variant="outline"
                size="sm"
                className="flex-wrap"
              >
                {INTENT_OPTIONS.map((opt) => (
                  <ToggleGroupItem key={opt.value} value={opt.value} title={opt.hint}>
                    {opt.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <p className="font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-warm-ghost">
                {INTENT_OPTIONS.find((o) => o.value === intent)?.hint}
              </p>
            </div>

            <div className="space-y-2">
              <Label
                htmlFor="suggestion-body"
                className="font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-warm-ghost uppercase block"
              >
                your suggestion
              </Label>
              <Textarea
                id="suggestion-body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Write in your own words. What do you want the knowledge base to know?"
                rows={8}
                className="rounded-sm font-serif text-[length:var(--text-body)] text-foreground placeholder:text-input focus-visible:border-gold-dim focus-visible:ring-0 resize-none"
                autoFocus
              />
            </div>

            {error && (
              <Alert variant="destructive" className="rounded-sm border-red-400/25 bg-red-400/5">
                <AlertDescription className="font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-red-400/90">
                  {error}
                </AlertDescription>
              </Alert>
            )}

            <div className="flex items-center gap-3 pt-2">
              <Button
                variant="ghost"
                onClick={() => onOpenChange(false)}
                disabled={submitting}
                className="font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-warm-ghost hover:text-warm-faint hover:bg-transparent h-auto px-3 py-1.5"
              >
                cancel
              </Button>
              <Button
                variant="ghost"
                onClick={handleSubmit}
                disabled={!canSubmit}
                className="font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-gold hover:text-gold-bright border border-gold-dim hover:border-gold h-auto px-4 py-1.5 disabled:opacity-40 disabled:pointer-events-none"
              >
                {submitting ? "submitting..." : "submit"}
              </Button>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
