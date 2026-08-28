<script lang="ts">
  import type {
    UserSuggestionIntent,
    UserSuggestionResult,
  } from "$lib/api/ingest";
  import { CHIP_ACTIVE, CHIP_BASE, CHIP_INACTIVE } from "$lib/chip";
  import { Button } from "$lib/components/ui/button";
  import { Label } from "$lib/components/ui/label";
  import { Textarea } from "$lib/components/ui/textarea";
  import { cn } from "$lib/utils";

  export interface SuggestionPayload {
    body: string;
    intent: UserSuggestionIntent;
  }

  type SuggestionMode = UserSuggestionResult["mode"];

  let {
    articleLabel,
    anchoredSection,
    expectedMode,
    onSubmit,
    onClose,
  }: {
    articleLabel: string;
    anchoredSection: string;
    expectedMode: SuggestionMode;
    onSubmit: (payload: SuggestionPayload) => Promise<SuggestionMode>;
    onClose: () => void;
  } = $props();

  const INTENT_OPTIONS = [
    {
      value: "disagree",
      label: "disagree",
      hint: "Offer a different interpretation or position.",
    },
    {
      value: "correct",
      label: "correct",
      hint: "Fix a factual error or sharpen a specific claim.",
    },
    {
      value: "add_context",
      label: "add context",
      hint: "Add evidence, background, or a missing angle.",
    },
    {
      value: "restructure",
      label: "restructure",
      hint: "Suggest a better scope, emphasis, or organization.",
    },
  ] as const satisfies readonly {
    value: UserSuggestionIntent;
    label: string;
    hint: string;
  }[];

  let intent = $state<UserSuggestionIntent>("add_context");
  let body = $state("");
  let submitting = $state(false);
  let error = $state<string | null>(null);
  let submittedMode = $state<SuggestionMode | null>(null);

  const selectedIntent = $derived(
    INTENT_OPTIONS.find((option) => option.value === intent)!,
  );
  const canSubmit = $derived(body.trim().length > 0 && !submitting);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    submitting = true;
    error = null;
    try {
      submittedMode = await onSubmit({ body: body.trim(), intent });
    } catch (cause) {
      error =
        cause instanceof TypeError
          ? "Suggestion could not be sent. Check your connection and try again."
          : cause instanceof Error && cause.message
            ? cause.message
            : "Suggestion could not be sent. Your draft is still here; try again.";
    } finally {
      submitting = false;
    }
  }
</script>

<section
  class="max-h-[70dvh] shrink-0 overflow-y-auto border-t border-ink-subtle bg-background px-4 pt-4 pb-[max(3.5rem,env(safe-area-inset-bottom))] sm:pb-5 md:px-10 md:pt-5"
  aria-labelledby="suggestion-heading"
>
  <div class="mx-auto max-w-[740px]">
    {#if submittedMode}
      <div
        class="flex flex-col gap-4 py-2 sm:flex-row sm:items-center sm:justify-between"
        role="status"
        aria-live="polite"
      >
        <div class="min-w-0">
          <h2
            id="suggestion-heading"
            class="font-serif text-[length:var(--text-body)] text-warm"
          >
            {submittedMode === "ingested"
              ? "Suggestion added"
              : "Suggestion sent for review"}
          </h2>
          <p
            class="mt-1 text-pretty font-mono text-[length:var(--text-chrome)] leading-relaxed text-warm-ghost"
          >
            {submittedMode === "ingested"
              ? "It is now a source and will inform the next knowledge-base update."
              : "The vault owner can approve it before it enters the knowledge base."}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onclick={onClose}
          class="h-auto shrink-0 self-start rounded-sm border border-gold-dim px-3 py-2 font-mono text-[length:var(--text-chrome)] text-gold hover:bg-interactive-dim sm:self-auto"
        >
          return to article
        </Button>
      </div>
    {:else}
      <div class="mb-4 flex min-w-0 items-baseline gap-2">
        <h2
          id="suggestion-heading"
          class="shrink-0 font-mono text-[length:var(--text-chrome)] text-gold-muted uppercase"
        >
          suggest
        </h2>
        <span class="text-warm-ghost">·</span>
        <span
          title={articleLabel}
          class="truncate font-serif text-[length:var(--text-small)] text-warm-faint"
        >
          {articleLabel}
        </span>
      </div>
      <p
        class="mb-4 text-pretty font-mono text-[length:var(--text-chrome)] leading-relaxed text-warm-ghost"
      >
        {expectedMode === "ingested"
          ? "Your note becomes a source and informs the next knowledge-base update."
          : "Your note goes to the vault owner for review before it becomes a source."}
      </p>

      <form class="space-y-5" onsubmit={(event) => void submit(event)}>
        <div class="space-y-2">
          <p
            class="font-mono text-[length:var(--text-chrome)] text-warm-ghost uppercase"
          >
            selected passage
          </p>
          <blockquote
            class="max-h-24 overflow-y-auto pr-2 font-serif text-[length:var(--text-small)] leading-relaxed text-warm-faint italic [overflow-wrap:anywhere]"
          >
            “{anchoredSection}”
          </blockquote>
        </div>

        <fieldset class="space-y-2" disabled={submitting}>
          <legend
            class="font-mono text-[length:var(--text-chrome)] text-warm-ghost uppercase"
          >
            intent
          </legend>
          <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {#each INTENT_OPTIONS as option (option.value)}
              <Button
                type="button"
                variant="ghost"
                aria-pressed={intent === option.value}
                onclick={() => (intent = option.value)}
                title={option.hint}
                class={cn(
                  CHIP_BASE,
                  "min-h-11 w-full justify-center whitespace-normal",
                  intent === option.value ? CHIP_ACTIVE : CHIP_INACTIVE,
                )}
              >
                {option.label}
              </Button>
            {/each}
          </div>
          <p
            id="suggestion-intent-hint"
            class="text-pretty font-mono text-[length:var(--text-chrome)] leading-relaxed text-warm-ghost"
            aria-live="polite"
          >
            {selectedIntent.hint}
          </p>
        </fieldset>

        <div class="space-y-2">
          <Label
            for="suggestion-body"
            class="font-mono text-[length:var(--text-chrome)] font-normal text-warm-ghost uppercase"
          >
            your suggestion
          </Label>
          <Textarea
            id="suggestion-body"
            bind:value={body}
            rows={5}
            autofocus
            disabled={submitting}
            aria-invalid={error !== null}
            aria-describedby={error
              ? "suggestion-intent-hint suggestion-body-error"
              : "suggestion-intent-hint"}
            placeholder="What should the knowledge base understand instead?"
            class="min-h-28 max-h-52 resize-y rounded-sm border-ink-border bg-transparent font-serif text-[length:var(--text-body)] leading-relaxed text-foreground placeholder:text-input focus-visible:border-gold-dim focus-visible:ring-0"
          />
          {#if error}
            <p
              id="suggestion-body-error"
              role="alert"
              class="text-pretty font-mono text-[length:var(--text-chrome)] leading-relaxed text-red-400/90"
            >
              {error}
            </p>
          {/if}
        </div>

        <div class="flex flex-wrap items-center gap-3 pt-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onclick={onClose}
            disabled={submitting}
            class="h-auto px-3 py-2 font-mono text-[length:var(--text-chrome)] text-warm-ghost hover:bg-transparent hover:text-warm-faint"
          >
            keep reading
          </Button>
          <Button
            type="submit"
            variant="ghost"
            size="sm"
            disabled={!canSubmit}
            class="h-auto rounded-sm border border-gold-dim bg-gold/10 px-4 py-2 font-mono text-[length:var(--text-chrome)] text-gold hover:bg-gold/15 disabled:pointer-events-none disabled:opacity-40"
          >
            {submitting
              ? expectedMode === "ingested"
                ? "adding…"
                : "sending…"
              : expectedMode === "ingested"
                ? "add suggestion"
                : "send for review"}
          </Button>
        </div>
      </form>
    {/if}
  </div>
</section>
