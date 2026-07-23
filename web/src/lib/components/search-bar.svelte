<script lang="ts">
  import { tick } from "svelte";

  import type { SessionSummary } from "$lib/api/sessions";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import type { Phase } from "$lib/types";
  import { formatRelativeDate } from "$lib/utils";

  let {
    query = $bindable(),
    phase,
    onSubmit,
    recentSessions,
    sessionsLoading = false,
    onSessionClick,
    onViewAllSessions,
  }: {
    query: string;
    phase: Phase;
    onSubmit: () => void;
    recentSessions?: SessionSummary[];
    sessionsLoading?: boolean;
    onSessionClick?: (id: string) => void;
    onViewAllSessions?: () => void;
  } = $props();

  let input: HTMLInputElement | null = $state(null);
  let focused = $state(false);
  const isActive = $derived(phase !== "idle");
  const showDropdown = $derived(
    focused &&
      !isActive &&
      !sessionsLoading &&
      !query.trim() &&
      (recentSessions?.length ?? 0) > 0,
  );

  $effect(() => {
    if (!isActive) {
      void tick().then(() => input?.focus());
    }
  });
</script>

<div class={`relative w-full ${isActive ? "" : "max-w-[640px]"}`}>
  <div
    class={`flex w-full items-center overflow-hidden border border-input bg-secondary focus-within:border-ring ${
      showDropdown
        ? "rounded-t-sm rounded-b-none border-b-transparent"
        : "rounded-sm"
    }`}
  >
    <Input
      bind:ref={input}
      bind:value={query}
      class="h-auto flex-1 rounded-none border-none bg-transparent px-[18px] py-[13px] font-serif text-[length:var(--text-body)] text-foreground caret-gold placeholder:text-input focus-visible:border-none focus-visible:ring-0 disabled:opacity-100 dark:bg-transparent"
      placeholder="Ask a question across the knowledge base..."
      onkeydown={(event) => event.key === "Enter" && onSubmit()}
      onfocus={() => (focused = true)}
      onblur={() => (focused = false)}
      disabled={isActive}
      autofocus={!isActive}
    />

    {#if !isActive}
      <Button
        onclick={onSubmit}
        disabled={!query.trim()}
        class="h-auto rounded-none bg-gold px-[18px] py-[13px] font-mono text-[length:var(--text-chrome)] font-medium tracking-[0.1em] text-primary-foreground hover:bg-gold-hover disabled:bg-interactive-ghost disabled:text-muted-foreground disabled:opacity-100"
      >
        query
      </Button>
    {/if}
  </div>

  {#if showDropdown}
    <div
      class="absolute top-full right-0 left-0 z-50 overflow-hidden rounded-b-sm border border-t-ink-subtle border-input bg-secondary"
    >
      {#each recentSessions?.slice(0, 3) ?? [] as session (session.id)}
        <button
          type="button"
          onmousedown={(event) => event.preventDefault()}
          onclick={() => {
            focused = false;
            onSessionClick?.(session.id);
          }}
          class="group flex w-full items-center justify-between px-[18px] py-2.5 text-left transition-colors hover:bg-ink-raised focus-visible:bg-ink-raised focus-visible:outline-none"
        >
          <span
            class="truncate font-serif text-[length:var(--text-small)] text-warm-dim italic group-hover:text-warm"
          >
            {session.query}
          </span>
          <span
            class="ml-3 shrink-0 font-mono text-[length:var(--text-chrome)] text-muted-foreground"
          >
            {formatRelativeDate(session.updated_at)}
          </span>
        </button>
      {/each}
      {#if onViewAllSessions}
        <button
          type="button"
          onmousedown={(event) => event.preventDefault()}
          onclick={() => {
            focused = false;
            onViewAllSessions?.();
          }}
          class="w-full border-t border-ink-subtle px-[18px] py-2 text-left font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-muted-foreground transition-colors hover:text-gold focus-visible:text-gold focus-visible:outline-none"
        >
          all sessions
        </button>
      {/if}
    </div>
  {/if}
</div>
