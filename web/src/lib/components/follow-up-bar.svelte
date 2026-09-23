<script lang="ts">
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import Square from "@lucide/svelte/icons/square";
  import X from "@lucide/svelte/icons/x";

  import ReplySubmissionError from "$lib/components/reply-submission-error.svelte";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";

  let {
    value = $bindable(),
    chips,
    disabled = false,
    submissionFailed = false,
    stopping = false,
    stopFailed = false,
    onStop,
    onValueChange,
    onRemoveChip,
    onSubmit,
  }: {
    value: string;
    chips: string[];
    disabled?: boolean;
    submissionFailed?: boolean;
    stopping?: boolean;
    stopFailed?: boolean;
    onStop?: () => void;
    onValueChange?: () => void;
    onRemoveChip: (index: number) => void;
    onSubmit: () => void;
  } = $props();

  const canSubmit = $derived(!disabled && (chips.length > 0 || !!value.trim()));
  const actionLabel = $derived(
    !disabled
      ? "Send follow-up"
      : stopping
        ? "Stopping response"
        : "Stop generating",
  );

  function submit() {
    if (!canSubmit) return;
    onSubmit();
  }
</script>

<div
  class="shrink-0 animate-[slide-up_0.28s_cubic-bezier(0.4,0,0.2,1)] border-t border-ink-subtle pt-3 pr-4 pb-3.5 pl-[var(--shell-utility-inset)] motion-reduce:animate-none md:pr-10"
>
  <form
    class="mx-auto flex w-full max-w-[740px] flex-col gap-2"
    onsubmit={(event) => {
      event.preventDefault();
      submit();
    }}
  >
    {#if chips.length > 0}
      <div class="flex flex-wrap gap-[5px]">
        {#each chips as chip, index (index)}
          <Badge
            variant="outline"
            class="flex h-auto max-w-[280px] items-center gap-[7px] rounded-sm border-gold-dim bg-interactive-dim py-1 pr-[9px] pl-[11px] text-[length:var(--text-caption)] text-warm-ghost italic"
          >
            <span
              class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap"
            >
              “{chip.length > 42 ? `${chip.slice(0, 42)}...` : chip}”
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              onclick={() => onRemoveChip(index)}
              {disabled}
              aria-label="remove selection"
              class="h-auto w-auto p-0 text-[length:var(--text-small)] text-gold-dim hover:bg-transparent hover:text-gold-muted"
            >
              <X size={12} />
            </Button>
          </Badge>
        {/each}
      </div>
    {/if}

    <div class="flex items-end gap-3">
      <textarea
        bind:value
        {disabled}
        rows={2}
        aria-label="Continue the conversation"
        class="max-h-52 min-h-12 w-full min-w-0 flex-1 resize-y border-0 border-b border-b-gold-dim bg-transparent py-1 font-serif text-[length:var(--text-small)] leading-[1.7] text-warm-dim italic caret-gold outline-none transition-colors placeholder:text-warm-faint focus:border-b-gold disabled:opacity-50"
        placeholder={chips.length > 0
          ? "Add context or send selected passages…"
          : "Continue the conversation…"}
        oninput={onValueChange}
        onkeydown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            submit();
          }
        }}></textarea>
      <Button
        type={disabled ? "button" : "submit"}
        variant="outline"
        size="icon"
        aria-label={actionLabel}
        title={actionLabel}
        disabled={disabled ? !onStop || stopping : !canSubmit}
        onclick={disabled ? onStop : undefined}
        class="shrink-0 border-gold-dim text-gold hover:bg-transparent hover:text-warm"
      >
        {#if disabled}
          <Square size={12} fill="currentColor" />
        {:else}
          <ArrowUp size={15} />
        {/if}
      </Button>
    </div>

    {#if submissionFailed}
      <ReplySubmissionError onRetry={onSubmit} />
    {/if}
    {#if stopFailed}
      <p
        role="alert"
        class="font-mono text-[length:var(--text-chrome)] text-destructive"
      >
        Couldn’t stop the response. Try again.
      </p>
    {/if}
  </form>
</div>
