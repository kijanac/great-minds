<script lang="ts">
  import { browser } from "$app/environment";

  import AnswerBlock from "$lib/components/answer-block.svelte";
  import FollowUpBar from "$lib/components/follow-up-bar.svelte";
  import PromoteButton from "$lib/components/promote-button.svelte";
  import SelectionPopover from "$lib/components/selection-popover.svelte";
  import ThinkingSection from "$lib/components/thinking-section.svelte";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Separator } from "$lib/components/ui/separator";
  import type { Session } from "$lib/session.svelte";
  import type { SourceRef } from "$lib/types";

  let {
    session,
    activeCard,
    panelDocked = false,
    onCardClick,
    onLinkClick,
  }: {
    session: Session;
    activeCard: string | null;
    panelDocked?: boolean;
    onCardClick: (source: SourceRef) => void;
    onLinkClick?: (event: MouseEvent) => void;
  } = $props();

  let hintDismissed = $state(
    browser && localStorage.getItem("onboarding-hint-seen") === "true",
  );
  const showHint = $derived(
    !hintDismissed && session.phase === "done" && session.thread.length === 1,
  );
  const canFollowUp = $derived(session.phase === "done");

  function dismissHint() {
    hintDismissed = true;
    localStorage.setItem("onboarding-hint-seen", "true");
  }

  function handleOutsideMouseDown(event: MouseEvent) {
    if (!session.popover) return;
    const target = event.target as Node | null;
    const popover = document.querySelector("[data-popover]");
    if (target && popover?.contains(target)) return;
    session.clearPopover();
  }

  function handleSelectionChange() {
    if (!session.popover) return;
    const selection = document.getSelection();
    if (selection && !selection.isCollapsed) return;
    const popover = document.querySelector("[data-popover]");
    if (popover?.contains(document.activeElement)) return;
    session.clearPopover();
  }

  $effect(() => {
    if (!browser) return;
    const clearOnScroll = () => session.clearPopover();
    document.addEventListener("mousedown", handleOutsideMouseDown);
    document.addEventListener("selectionchange", handleSelectionChange);
    window.addEventListener("scroll", clearOnScroll, true);
    return () => {
      document.removeEventListener("mousedown", handleOutsideMouseDown);
      document.removeEventListener("selectionchange", handleSelectionChange);
      window.removeEventListener("scroll", clearOnScroll, true);
    };
  });
</script>

<div
  class="min-h-0 flex-1 overflow-y-auto"
  onclick={onLinkClick}
  role={onLinkClick ? "presentation" : undefined}
>
  <div id="session-print" class="mx-auto max-w-[740px] px-4 pt-7 pb-5 md:px-10">
    {#each session.thread as exchange, index (exchange.id)}
      <div>
        {#if index > 0}
          <Separator class="my-8 bg-ink-subtle" />
        {/if}

        <div class="mb-[18px] flex items-center justify-between gap-3">
          <span
            class="text-[length:var(--text-small)] text-muted-foreground italic"
          >
            “{exchange.query}”
          </span>
          {#if session.sessionId && exchange.answer && !exchange.streaming}
            <span class="print:hidden">
              <PromoteButton
                sessionId={session.sessionId}
                exchangeId={exchange.id}
              />
            </span>
          {/if}
        </div>

        <div class="print:hidden">
          <ThinkingSection
            blocks={exchange.thinking}
            streaming={exchange.streaming && !exchange.answer}
            {onCardClick}
            {activeCard}
          />
        </div>

        {#if exchange.answer}
          <AnswerBlock
            text={exchange.answer}
            exchangeId={exchange.id}
            btws={exchange.btws}
            streaming={exchange.streaming}
            {panelDocked}
            onSelection={session.handleSelection}
            onBtwReply={session.replyBtw}
            onBtwDismiss={session.dismissBtw}
          />
        {/if}
      </div>
    {/each}
  </div>
</div>

{#if showHint}
  <div
    class="shrink-0 animate-[slide-up_0.28s_ease] border-t border-ink-subtle px-4 py-3 md:px-10"
  >
    <div class="mx-auto flex max-w-[740px] items-center justify-between gap-4">
      <p
        class="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-faint"
      >
        <Badge
          variant="outline"
          class="mr-2 border-gold-dim font-mono text-[length:var(--text-chrome)] tracking-[0.08em] text-gold-muted"
        >
          tip
        </Badge>
        highlight any text in the answer to
        <span class="text-warm-dim">follow up</span>
        or start a <span class="text-btw">btw</span> thread
      </p>
      <Button
        variant="ghost"
        size="sm"
        onclick={dismissHint}
        class="h-auto shrink-0 px-2 py-1 font-mono text-[length:var(--text-chrome)] tracking-[0.08em] text-warm-ghost hover:bg-transparent hover:text-warm-faint"
      >
        dismiss
      </Button>
    </div>
  </div>
{/if}

{#if canFollowUp}
  <FollowUpBar
    chips={session.chips}
    onRemoveChip={session.removeChip}
    onSubmit={session.submitFollowUp}
  />
{/if}

{#if session.popover}
  <SelectionPopover
    info={session.popover}
    onFollowUp={() => {
      if (session.popover) session.addChip(session.popover.quote);
    }}
    onBtw={() => {
      if (session.popover) session.startBtw(session.popover);
    }}
  />
{/if}
