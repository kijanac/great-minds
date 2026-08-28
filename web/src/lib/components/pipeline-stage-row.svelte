<script lang="ts">
  import ChevronDown from "@lucide/svelte/icons/chevron-down";

  import * as Collapsible from "$lib/components/ui/collapsible";
  import { Progress } from "$lib/components/ui/progress";
  import type {
    ProgressStep,
    StageProgress,
  } from "$lib/hooks/use-job-sse.svelte";

  let {
    stage,
  }: {
    stage: StageProgress;
  } = $props();

  let open = $state(false);
  const expandable = $derived(stage.active || stage.complete || stage.errored);
  const hasCount = $derived(stage.active && stage.total > 1);

  $effect(() => {
    open = expandable;
  });

  function stepSymbol(step: ProgressStep): string {
    if (step.status === "failed") return "✗";
    if (step.status === "completed") return "✓";
    if (step.status === "running") return "◉";
    return "○";
  }
</script>

<div
  class="border-b border-ink-subtle last:border-b-0"
  data-active-stage={stage.active ? "" : undefined}
>
  <Collapsible.Root bind:open disabled={!expandable}>
    <Collapsible.Trigger
      class="flex w-full items-center gap-4 py-4 text-left disabled:cursor-default"
    >
      <span class="flex size-5 shrink-0 items-center justify-center">
        {#if stage.errored}
          <span class="text-sm text-warm-faint">✗</span>
        {:else if stage.complete}
          <span class="text-sm text-gold-dim">✓</span>
        {:else if stage.active}
          <span
            class="animate-[pulse-fade_1.6s_ease-in-out_infinite] text-sm text-gold"
          >
            ◉
          </span>
        {:else}
          <span class="text-sm text-warm-ghost">○</span>
        {/if}
      </span>

      <span
        class={`min-w-0 flex-1 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] uppercase ${
          stage.complete
            ? "text-gold-dim"
            : stage.active
              ? "text-gold"
              : stage.errored
                ? "text-warm-faint"
                : "text-warm-ghost"
        }`}
      >
        {stage.label}
      </span>

      {#if hasCount}
        <span
          class="shrink-0 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-warm-ghost"
        >
          {stage.done} / {stage.total}
        </span>
      {/if}

      {#if expandable}
        <ChevronDown
          size={14}
          class={`shrink-0 text-warm-ghost transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      {/if}
    </Collapsible.Trigger>

    <Collapsible.Content>
      <div class="pb-4 pl-9">
        {#if stage.active && stage.detail}
          <div
            class="font-serif text-[length:var(--text-small)] text-warm-faint"
          >
            {stage.detail}
          </div>
        {/if}

        {#if stage.steps.length > 0}
          <ul class="mt-3 space-y-1.5">
            {#each stage.steps as step (step.key)}
              <li
                class="flex items-center gap-2 font-mono text-[length:var(--text-chrome)] tracking-[0.06em]"
              >
                <span
                  class={step.status === "completed"
                    ? "text-gold-dim"
                    : step.status === "running"
                      ? "animate-[pulse-fade_1.6s_ease-in-out_infinite] text-gold"
                      : "text-warm-ghost"}
                >
                  {stepSymbol(step)}
                </span>
                <span
                  class={step.status === "running"
                    ? "text-warm-faint"
                    : "text-warm-ghost"}
                >
                  {step.label}
                </span>
                {#if step.total != null && step.total > 0 && step.done != null}
                  <span class="tabular-nums text-warm-ghost">
                    {step.done} / {step.total}
                  </span>
                {/if}
                {#if step.detail}
                  <span class="truncate text-warm-ghost">· {step.detail}</span>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}

        {#if hasCount}
          <Progress
            value={(stage.done / stage.total) * 100}
            class="mt-2 bg-ink-border [&_[data-slot=progress-indicator]]:bg-gold"
          />
        {/if}
      </div>
    </Collapsible.Content>
  </Collapsible.Root>
</div>
