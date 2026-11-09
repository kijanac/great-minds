<script lang="ts">
  import type { RunStage } from "@great-minds/domain";

  let {
    track,
    running,
    startedAt,
    completedAt,
  }: {
    track: readonly RunStage[];
    running: boolean;
    startedAt: Date | null;
    completedAt: Date | null;
  } = $props();

  let opened = $state<string | null>(null);
  let now = $state(Date.now());

  $effect(() => {
    if (!running) return;
    const timer = window.setInterval(() => (now = Date.now()), 30_000);
    return () => window.clearInterval(timer);
  });

  const currentIndex = $derived.by(() => {
    const live = track.findIndex(
      (stage) => stage.status === "running" || stage.status === "failed",
    );
    if (live !== -1) return live;
    const pending = track.findIndex((stage) => stage.status === "pending");
    return pending === -1 ? track.length - 1 : pending;
  });
  const current = $derived(track[currentIndex]);
  const shown = $derived(track.find((stage) => stage.key === opened) ?? current);
  const counted = $derived(
    current?.steps.find(
      (step) => step.status === "running" && step.total != null && step.total > 0,
    ),
  );
  const leftOut = $derived(track.flatMap((stage) => stage.warnings));

  const fmt = (value: number) => value.toLocaleString("en-US");
  const clock = (date: Date) =>
    date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const span = (ms: number) => {
    const minutes = Math.max(0, Math.round(ms / 60_000));
    if (minutes < 1) return "less than a minute";
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return hours === 0 ? `${rest} min` : rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
  };
</script>

{#if running && current}
  <div
    class="mb-3.5 flex items-center gap-2 font-mono text-[length:var(--text-chrome)] font-medium tracking-[0.16em] text-gold-muted uppercase"
  >
    <span class="size-[7px] animate-[pulse-fade_1.6s_ease-in-out_infinite] rounded-full bg-gold"
    ></span>
    Updating your library
  </div>
  <h1 class="mb-6 font-serif text-[length:var(--text-title)] leading-[1.25] text-warm">
    {current.title}
  </h1>
  <div
    class="mb-2 h-[3px] overflow-hidden rounded-full bg-ink-subtle"
    role="progressbar"
    aria-valuemin={0}
    aria-valuemax={counted?.total ?? 1}
    aria-valuenow={counted?.done ?? 0}
  >
    <div
      class="h-full bg-gold transition-[width] duration-500"
      style:width={counted?.total
        ? `${Math.round((100 * (counted.done ?? 0)) / counted.total)}%`
        : "0%"}
    ></div>
  </div>
  <div
    class="mb-8 flex justify-between font-mono text-[length:var(--text-caption)] text-warm-ghost"
  >
    <span>{counted?.total != null ? `${fmt(counted.done ?? 0)} of ${fmt(counted.total)}` : ""}</span
    >
    <span>step {currentIndex + 1} of {track.length}</span>
  </div>
{/if}

<ol class="grid gap-1.5" style:grid-template-columns={`repeat(${track.length}, minmax(0, 1fr))`}>
  {#each track as stage (stage.key)}
    <li>
      <button
        type="button"
        onclick={() => (opened = stage.key)}
        aria-pressed={shown?.key === stage.key}
        class={`w-full border-t-2 pt-[7px] text-left font-mono text-[10px] leading-[1.4] tracking-[0.04em] ${
          stage.status === "failed"
            ? "border-destructive text-destructive"
            : stage.status === "running"
              ? "border-gold text-warm"
              : stage.status === "completed"
                ? "border-gold-dim text-gold-muted"
                : "border-ink-subtle text-warm-ghost/70"
        } ${shown?.key === stage.key ? "underline decoration-gold-dim underline-offset-[3px]" : ""}`}
      >
        {stage.label}
      </button>
    </li>
  {/each}
</ol>

{#if shown}
  <ul
    class="mt-2.5 mb-1 min-h-[22px] space-y-0.5 border-l border-ink-subtle pl-3 font-mono text-[11px] leading-[1.9] text-warm-faint"
  >
    {#each shown.steps as step (step.key)}
      <li
        class={`grid grid-cols-[1fr_auto] gap-3 ${step.status === "pending" ? "text-warm-ghost/70" : step.status === "failed" ? "text-destructive" : ""}`}
      >
        <span
          >{step.status === "completed"
            ? "✓ "
            : step.status === "running"
              ? "• "
              : step.status === "failed"
                ? "✗ "
                : ""}{step.label}</span
        >
        <span class="tabular-nums"
          >{step.status === "running" && step.total
            ? `${fmt(step.done ?? 0)} / ${fmt(step.total)}`
            : step.status === "completed" && step.done
              ? fmt(step.done)
              : ""}</span
        >
      </li>
    {/each}
  </ul>
{/if}

{#if leftOut.length > 0}
  <div class="mt-7 space-y-2">
    {#each leftOut as warning, index (`${warning.phase}:${warning.message}:${index}`)}
      <div
        class="border-l-2 border-destructive py-0.5 pl-3.5 font-serif text-[length:var(--text-small)] leading-[1.7] text-warm-faint"
      >
        <span class="text-destructive">Left out:</span>
        {warning.count}
        {warning.message}
        {#if warning.items.length > 0}
          <details class="mt-1">
            <summary
              class="cursor-pointer list-none font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-gold-muted [&::-webkit-details-marker]:hidden"
              >which</summary
            >
            <ul class="mt-1 ml-4 list-disc">
              {#each [...new Set(warning.items)] as item (item)}
                <li class="[overflow-wrap:anywhere]">{item}</li>
              {/each}
            </ul>
          </details>
        {/if}
      </div>
    {/each}
  </div>
{/if}

{#if startedAt && (running || completedAt)}
  <p class="mt-7 font-mono text-[length:var(--text-chrome)] text-warm-ghost">
    {running
      ? `Started at ${clock(startedAt)} · running for ${span(now - startedAt.getTime())}`
      : `Took ${span((completedAt ?? startedAt).getTime() - startedAt.getTime())}`}
  </p>
{/if}
