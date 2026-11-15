<script lang="ts">
  import { page } from "$app/state";
  import type { MemberRole } from "@great-minds/domain";
  import { tick } from "svelte";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import type { crossfade } from "svelte/transition";

  import AnswerBlock from "#lib/components/answer-block.svelte";
  import AnswerSteps from "#lib/components/answer-steps.svelte";
  import { outlineOf } from "#lib/citations.ts";
  import FollowUpBar from "#lib/components/follow-up-bar.svelte";
  import OnboardingHint, {
    dismissOnboardingHint,
    onboardingHintSeen,
  } from "#lib/components/onboarding-hint.svelte";
  import PromoteButton from "#lib/components/promote-button.svelte";
  import ReplyInterrupted from "#lib/components/reply-interrupted.svelte";
  import SelectionPopover from "#lib/components/selection-popover.svelte";
  import SessionPassage from "#lib/components/session-passage.svelte";
  import ThreadSurface from "#lib/components/thread-surface.svelte";
  import { Button } from "#lib/components/ui/button/index.ts";
  import { unsponsoredNotice, useMe } from "#lib/hooks/use-me.svelte.ts";
  import type { Conversation } from "#lib/conversation.svelte.ts";
  import { sessionOriginHref } from "#lib/session-origin.ts";
  import { passageMark, revealPassage } from "#lib/passage-navigation.ts";
  import type { Exchange, SelectionInfo, SourceRef } from "#lib/types.ts";
  import { docDisplayName } from "#lib/utils.ts";

  let {
    session,
    activeCard,
    vaultRole = null,
    panelDocked = false,
    onCardClick,
    onOpenPath,
    onLinkClick,
    receive,
  }: {
    session: Conversation;
    activeCard: string | null;
    vaultRole?: MemberRole | null;
    panelDocked?: boolean;
    onCardClick: (source: SourceRef) => void;
    onOpenPath: (path: string, chunk: number | null) => void;
    onLinkClick?: (event: MouseEvent) => void;
    receive?: ReturnType<typeof crossfade>[1];
  } = $props();

  const me = useMe();

  const openCitation = (href: string, path: string) => {
    const fragment = href.split("#", 2)[1] ?? "";
    const match = /^\^p(\d+)$/.exec(decodeURIComponent(fragment));
    onOpenPath(path, match ? Number(match[1]) : null);
  };

  const readMore = (exchange: Exchange) => {
    const seen = new Set<string>();
    return exchange.thinking
      .flatMap((block) => block.sources)
      .filter((source) => {
        if (source.type !== "article" || source.pending || seen.has(source.label)) return false;
        seen.add(source.label);
        return true;
      })
      .slice(0, 3);
  };

  const outline = $derived(
    session.exchanges.flatMap((exchange, index) => [
      ...(index === 0
        ? []
        : [
            {
              id: `exchange-${exchange.id}`,
              label: exchange.query,
              question: true,
              heading: -1,
            },
          ]),
      ...outlineOf(exchange.answer).map((label, heading) => ({
        id: `exchange-${exchange.id}`,
        label,
        question: false,
        heading,
      })),
    ]),
  );

  const outlineTarget = (id: string, heading: number) => {
    const section = document.getElementById(id);
    return heading < 0
      ? section
      : section?.querySelectorAll<HTMLElement>("[data-answer] h2, [data-answer] h3")[heading];
  };

  function jump(id: string, heading: number) {
    outlineTarget(id, heading)?.scrollIntoView({
      block: "start",
      behavior: "smooth",
    });
  }

  let activeOutline = $state(-1);
  let spyFrame = 0;

  function updateActiveOutline() {
    if (!viewport) return;
    const view = viewport.getBoundingClientRect();
    const atBottom = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 2;
    const line = atBottom ? view.bottom : view.top + 96;
    let active = -1;
    outline.forEach((entry, index) => {
      const target = outlineTarget(entry.id, entry.heading);
      if (target && target.getBoundingClientRect().top <= line) active = index;
    });
    activeOutline = active;
  }

  function spyOutline() {
    cancelAnimationFrame(spyFrame);
    spyFrame = requestAnimationFrame(updateActiveOutline);
  }

  $effect(() => {
    void outline;
    spyOutline();
    return () => cancelAnimationFrame(spyFrame);
  });

  const title = (query: string) =>
    query.length > 0 ? query[0]!.toUpperCase() + query.slice(1) : query;

  const origin = $derived(session.origin);
  let viewport: HTMLDivElement | undefined = $state();
  let content: HTMLDivElement | undefined = $state();
  let following = false;
  let previousScrollTop = 0;

  function followBottom(behavior: ScrollBehavior = "instant") {
    viewport?.scrollTo({
      top: viewport.scrollHeight,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : behavior,
    });
  }

  function handleScroll() {
    if (!viewport) return;
    spyOutline();
    const bottom = viewport.scrollHeight - viewport.clientHeight;
    if (viewport.scrollTop < Math.min(previousScrollTop, bottom)) {
      following = false;
    } else if (bottom - viewport.scrollTop < 32 && session.phase !== "done") {
      following = true;
    }
    previousScrollTop = viewport.scrollTop;
  }

  let followUpDraft = $state("");
  let chips = $state<string[]>([]);
  let popover = $state<SelectionInfo | null>(null);

  async function submitFollowUp() {
    const draft = followUpDraft;
    const selectedChips = [...chips];
    const question = [...selectedChips.map((chip) => `re: "${chip}"`), draft.trim()]
      .filter(Boolean)
      .join(" — ");
    const previous = session.exchanges.at(-1)?.id;
    const accepted = session.ask(question);
    if (session.exchanges.at(-1)?.id !== previous) {
      await tick();
      following = true;
      followBottom("smooth");
    }
    if (!(await accepted)) return;
    if (followUpDraft === draft) followUpDraft = "";
    if (selectedChips.every((chip, index) => chips[index] === chip))
      chips = chips.slice(selectedChips.length);
  }

  function clearSelection() {
    popover = null;
    window.getSelection()?.removeAllRanges();
  }

  $effect(() => {
    if (!content) return;
    const observer = new ResizeObserver(() => {
      if (following && session.phase === "streaming") followBottom();
    });
    observer.observe(content);
    return () => observer.disconnect();
  });

  $effect(() => {
    if (session.phase !== "done") return;
    void tick().then(() => {
      if (following) followBottom();
      following = false;
    });
  });
  const originDocPath = $derived(origin?.kind === "document" ? origin.doc_path : null);
  const originHref = $derived(
    origin && session.sessionId ? sessionOriginHref(origin, session.sessionId) : null,
  );

  let focusedThread: string | null = null;
  $effect(() => {
    const target = page.url.searchParams.get("thread");
    if (!target || focusedThread === target) return;
    const thread = session.exchanges
      .flatMap((exchange) => exchange.btws)
      .find((btw) => btw.sessionId === target);
    if (!thread) return;
    focusedThread = target;
    void tick().then(() => {
      const mark = passageMark(thread.id);
      const element = mark ?? document.getElementById(`thread-${target}`);
      if (element) revealPassage(element);
    });
  });
  const showHint = $derived(
    !onboardingHintSeen() &&
      !origin?.anchor &&
      session.phase === "done" &&
      session.submission.status !== "failed" &&
      session.exchanges.length === 1 &&
      (session.exchanges[0]?.error === null || session.exchanges[0]?.error === undefined),
  );

  function handleSelectionChange() {
    if (!popover) return;
    const selection = document.getSelection();
    if (selection && !selection.isCollapsed) return;
    if (document.querySelector("[data-popover]")?.contains(document.activeElement)) return;
    popover = null;
  }
</script>

<svelte:document onselectionchange={handleSelectionChange} />

<div
  bind:this={viewport}
  class="min-h-0 flex-1 overflow-y-auto"
  onscroll={handleScroll}
  onclick={onLinkClick}
  role={onLinkClick ? "presentation" : undefined}
>
  <div bind:this={content} class="relative mx-auto max-w-[740px] px-4 pt-9 pb-8 md:px-10">
    {#if outline.length >= 3 && !origin?.anchor && !panelDocked}
      <aside
        class="absolute top-0 right-[calc(100%+1rem)] hidden h-full w-[190px] min-[1200px]:block"
      >
        <nav
          aria-label="in this conversation"
          class="sticky top-9 font-mono text-[length:var(--text-chrome)] leading-[1.5]"
        >
          <div class="mb-2.5 tracking-[0.14em] text-gold-muted uppercase">In this conversation</div>
          {#each outline as entry, index (`${entry.id}:${entry.heading}:${index}`)}
            <button
              type="button"
              onclick={() => jump(entry.id, entry.heading)}
              aria-current={index === activeOutline ? "location" : undefined}
              class={`block w-full border-l py-1 pl-2.5 text-left transition-colors hover:border-gold hover:text-warm [overflow-wrap:anywhere] ${entry.question ? "mt-3 italic" : ""} ${index === activeOutline ? "border-gold text-warm" : entry.question ? "border-ink-border text-warm-faint" : "border-ink-subtle text-warm-ghost"}`}
              >{entry.label}</button
            >
          {/each}
        </nav>
      </aside>
    {/if}
    {#if originHref && !origin?.anchor}
      <div class="mb-6">
        <a
          href={originHref}
          class="inline-flex items-baseline gap-2 font-mono text-[length:var(--text-chrome)] leading-relaxed text-gold underline-offset-4 hover:underline [overflow-wrap:anywhere]"
        >
          <ArrowLeft size={12} class="shrink-0 self-center" />
          <span
            >{origin?.anchor ? "Return to passage" : "Return to source"} · {session.originTitle ??
              (origin?.kind === "answer"
                ? "parent session"
                : docDisplayName(originDocPath ?? ""))}</span
          >
        </a>
      </div>
    {/if}

    {#if origin?.anchor}
      <ThreadSurface>{@render conversation()}</ThreadSurface>
    {:else}
      {@render conversation()}
    {/if}

    {#snippet conversation()}
      {#each session.exchanges as exchange, index (exchange.id)}
        {@const streaming = exchange.status === "running" && session.phase !== "finalizing"}
        <section id={`exchange-${exchange.id}`} class="scroll-mt-6">
          {#if index === 0}
            {#if receive}
              <h1
                in:receive={{ key: "search-bar" }}
                class="mb-3 font-serif text-[length:var(--text-title)] leading-[1.3] text-warm whitespace-pre-wrap [overflow-wrap:anywhere]"
              >
                {title(exchange.query)}
              </h1>
            {:else}
              <h1
                class="mb-3 font-serif text-[length:var(--text-title)] leading-[1.3] text-warm whitespace-pre-wrap [overflow-wrap:anywhere]"
              >
                {title(exchange.query)}
              </h1>
            {/if}
          {:else}
            <h2
              class="mt-14 mb-3 border-t border-ink-subtle pt-7 font-serif text-[length:var(--text-heading)] leading-[1.4] text-warm italic whitespace-pre-wrap [overflow-wrap:anywhere]"
            >
              {exchange.query}
            </h2>
          {/if}

          {#if index === 0 && origin?.anchor}
            <SessionPassage
              quote={origin.anchor}
              context={origin.paragraph}
              href={originHref}
              sourceTitle={session.originTitle ?? undefined}
            />
          {/if}

          <AnswerSteps blocks={exchange.thinking} {streaming} onOpen={onCardClick} />

          {#if exchange.answer}
            <div data-answer>
              <AnswerBlock
                text={exchange.answer}
                citations={exchange.citations}
                exchangeId={exchange.id}
                btws={exchange.btws}
                {streaming}
                {panelDocked}
                onSelection={(info) => (popover = info)}
                onBtwDismiss={session.dismissBtw}
                onCitation={(citation) => openCitation(citation.href, citation.path)}
              />
            </div>
          {/if}

          {#if exchange.status === "stopped" || exchange.status === "failed"}
            <ReplyInterrupted
              partial={exchange.answer.length > 0}
              stopped={exchange.status === "stopped"}
              onRetry={exchange.status === "failed" &&
              session.phase === "done" &&
              index === session.exchanges.length - 1 &&
              exchange.replyId
                ? () => session.retry(exchange.id)
                : undefined}
            />
          {:else if exchange.status === "completed" && !exchange.answer}
            <p class="text-[length:var(--text-small)] text-warm-faint">
              The response completed without an answer.
            </p>
          {/if}

          {#if exchange.answer && !streaming && (exchange.status === "completed" || exchange.status === "stopped")}
            {@const more = readMore(exchange)}
            {@const canPromote =
              !!session.sessionId && (vaultRole === "owner" || vaultRole === "editor")}
            {#if more.length > 0 || canPromote}
              <div
                class="mt-5 flex flex-wrap items-baseline justify-between gap-x-5 gap-y-2 border-t border-dashed border-ink-subtle pt-3"
              >
                {#if more.length > 0}
                  <div class="font-serif text-[length:var(--text-small)] leading-[1.7]">
                    <span
                      class="mr-2 font-mono text-[10px] tracking-[0.14em] text-gold-muted uppercase"
                      >Read more</span
                    >{#each more as source, position (source.label)}{#if position > 0}<span
                          class="mx-1.5 text-ink-border">·</span
                        >{/if}<button
                        type="button"
                        onclick={() => onCardClick(source)}
                        class={`underline decoration-gold-dim underline-offset-[3px] hover:text-gold ${activeCard === source.label ? "text-gold" : "text-gold-muted"}`}
                        >{source.title ?? source.label}</button
                      >{/each}
                  </div>
                {/if}
                {#if canPromote && session.sessionId && (vaultRole === "owner" || vaultRole === "editor")}
                  <PromoteButton
                    sessionId={session.sessionId}
                    exchangeId={exchange.id}
                    role={vaultRole}
                    locked={!me.canUseModels}
                  />
                {/if}
              </div>
            {/if}
          {/if}
        </section>
      {/each}
    {/snippet}
  </div>
</div>

{#if showHint}
  <OnboardingHint>
    highlight text to <span class="text-warm-dim">add to reply</span> or ask with
    <span class="text-btw">btw</span>
  </OnboardingHint>
{/if}

{#if session.connectionError || session.phase === "finalizing" || session.activity?.status === "admitting"}
  <div
    role="status"
    class="shrink-0 px-4 py-3 font-mono text-[length:var(--text-chrome)] text-warm-faint md:px-10"
  >
    <div class="mx-auto flex max-w-[740px] flex-wrap items-baseline gap-3">
      {#if session.connectionError}
        <span>{session.connectionError}</span>
        <Button
          variant="link"
          class="h-auto p-0 font-mono text-[length:var(--text-chrome)] text-gold"
          onclick={session.reconnect}>Reconnect</Button
        >
      {:else}
        {session.activity?.status === "admitting"
          ? "Saving question…"
          : "Saving response… You can follow up when it is saved."}
      {/if}
    </div>
  </div>
{/if}

{#if session.phase !== "idle"}
  <FollowUpBar
    bind:value={followUpDraft}
    {chips}
    disabled={session.phase !== "done" || !me.canUseModels}
    submissionFailed={session.submission.status === "failed"}
    stopping={session.stopping}
    stopFailed={session.stopFailed}
    finalizing={session.phase === "finalizing"}
    onStop={session.canStop ? session.stop : undefined}
    onValueChange={session.clearSubmissionFailure}
    onRemoveChip={(index) => {
      session.clearSubmissionFailure();
      chips = chips.filter((_, itemIndex) => itemIndex !== index);
    }}
    onSubmit={submitFollowUp}
  />
  {#if !me.canUseModels}
    <p
      class="mx-auto w-full max-w-[720px] px-4 pb-4 font-mono text-[length:var(--text-chrome)] leading-[1.7] tracking-[0.04em] text-warm-faint"
    >
      {unsponsoredNotice}
    </p>
  {/if}
{/if}

{#if popover}
  {@const selection = popover}
  <SelectionPopover
    info={selection}
    onDismiss={() => (popover = null)}
    onFollowUp={() => {
      session.clearSubmissionFailure();
      chips = [...chips, selection.quote];
      clearSelection();
      dismissOnboardingHint();
    }}
    onBtw={() => {
      session.startBtw(selection);
      clearSelection();
      dismissOnboardingHint();
    }}
  />
{/if}
