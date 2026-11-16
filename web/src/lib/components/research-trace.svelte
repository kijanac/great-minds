<script lang="ts">
  import { plural } from "@great-minds/client";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import { untrack } from "svelte";

  import SourceStrip from "#lib/components/source-strip.svelte";
  import {
    answerText,
    readLabel,
    researchRounds,
    type ReadStep,
    type ResearchStep,
  } from "#lib/research-steps.ts";
  import type { Exchange, SourceRef } from "#lib/types.ts";
  import { displayTitle } from "#lib/utils.ts";

  let {
    exchange,
    compact = false,
    onOpen,
  }: {
    exchange: Exchange;
    compact?: boolean;
    onOpen?: (source: SourceRef) => void;
  } = $props();

  const rounds = $derived(
    researchRounds(
      exchange.thinking.flatMap((block) => block.sources),
      exchange.answer,
    ),
  );
  const steps = $derived(rounds.flatMap((round) => round.steps));
  const reads = $derived(
    steps.filter((step): step is ReadStep => step.kind === "read" && !step.pending),
  );
  const running = $derived(exchange.status === "running");
  const answering = $derived(answerText(exchange) !== "");
  const busy = $derived(
    steps.some((step) => step.pending || (step.kind === "read" && step.fetching.size > 0)),
  );
  const digesting = $derived(running && !answering && !busy && steps.length > 0);

  let latestRound: string | null = null;
  const signatures = new Map<string, string>();
  let recent = $state<ReadonlySet<string>>(new Set());
  $effect.pre(() => {
    const latest = rounds.at(-1)?.key ?? null;
    const next = new Set(latest === latestRound ? untrack(() => recent) : []);
    latestRound = latest;
    for (const step of reads) {
      const signature = `${step.read.size}:${step.source.outline === true}:${step.source.full === true}`;
      if (signatures.get(step.source.label) !== signature) next.add(step.source.label);
      signatures.set(step.source.label, signature);
    }
    recent = next;
  });
  const glowing = (step: ResearchStep) =>
    digesting && step.kind === "read" && recent.has(step.source.label);

  let now = $state(Date.now());
  $effect(() => {
    if (!running) return;
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });
  const clock = $derived.by(() => {
    if (exchange.startedAt === undefined) return null;
    const seconds = Math.max(0, Math.floor((now - exchange.startedAt.getTime()) / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  });

  let open = $state<boolean | null>(null);
  const folded = $derived(open === null ? compact || !running || answering : !open);

  const title = (source: SourceRef) => displayTitle(source.label, source.title);
  const topic = (label: string) => /^contains: (.*?)(, sort:.*)?$/.exec(label)?.[1] ?? null;
  const active = (step: ResearchStep) =>
    step.pending || (step.kind === "read" && step.fetching.size > 0) || glowing(step);

  const verb = (step: ResearchStep, now: boolean) => {
    const source = step.source;
    if (step.kind === "read")
      return `${now ? "reading" : "read"} ${source.type === "article" ? "article" : "source"}`;
    if (step.kind === "links") return `${now ? "following" : "followed"} links from`;
    if (step.kind === "query")
      return topic(source.label) === null
        ? `${now ? "filtering" : "filtered"} sources by`
        : `${now ? "listing" : "listed"} articles about`;
    if (source.scope === "web") return `${now ? "searching" : "searched"} the web for`;
    return source.path === null
      ? now
        ? "searching"
        : "searched"
      : `${now ? "searching" : "searched"} within`;
  };

  const result = (step: ResearchStep) => {
    const count = step.source.results;
    if (step.pending || count === undefined) return null;
    if (step.kind === "links") return plural(count, "linked article");
    if (step.kind === "query")
      return plural(count, topic(step.source.label) === null ? "source" : "article");
    if (step.source.scope === "web") return plural(count, "result");
    return plural(count, "passage");
  };

  const status = $derived.by((): { lead: string; object: string | null } => {
    if (answering) return { lead: "Writing the answer", object: null };
    if (digesting) {
      const titles = reads
        .filter((step) => recent.has(step.source.label))
        .map((s) => title(s.source));
      return titles.length > 0
        ? { lead: "Reading", object: titles.join(" and ") }
        : { lead: "Thinking", object: null };
    }
    const current = steps.findLast(
      (step) => step.pending || (step.kind === "read" && step.fetching.size > 0),
    );
    if (current === undefined) return { lead: "Thinking", object: null };
    const lead = verb(current, true);
    if (current.kind === "read" || current.kind === "links")
      return { lead: lead[0].toUpperCase() + lead.slice(1), object: title(current.source) };
    return {
      lead: lead[0].toUpperCase() + lead.slice(1),
      object: `“${topic(current.source.label) ?? current.source.label}”`,
    };
  });
  const statusKey = $derived(`${status.lead}:${status.object ?? ""}`);
  const focus = $derived(
    reads.find((step) => glowing(step)) ??
      steps.findLast(
        (step): step is ReadStep =>
          step.kind === "read" && (step.pending || step.fetching.size > 0),
      ),
  );

  const articles = $derived(reads.filter((step) => step.source.type === "article").length);
  const summary = $derived.by(() => {
    if (exchange.status === "stopped" && !answering)
      return `Stopped after ${plural(steps.length, "step")}`;
    if (reads.length === 0) return "Answered without reading the library";
    const parts = [
      articles > 0 ? plural(articles, "article") : null,
      reads.length > articles ? plural(reads.length - articles, "source") : null,
    ].filter((part) => part !== null);
    return `Answered from ${parts.join(" and ")}`;
  });
  const serif = "font-serif text-[length:var(--text-caption)] italic tracking-normal text-warm-dim";
  const fill = (step: ReadStep) =>
    step.source.full === true
      ? 1
      : step.source.chunks
        ? Math.max(0.12, step.read.size / step.source.chunks)
        : 0.3;
</script>

{#snippet object(step: ResearchStep)}
  {#if (step.kind === "read" || step.kind === "links") && onOpen && !step.pending}
    <button
      type="button"
      class={`${serif} underline decoration-ink-border decoration-dotted underline-offset-4 transition-colors hover:text-gold hover:decoration-gold hover:decoration-solid`}
      onclick={() => onOpen?.(step.source)}>{title(step.source)}</button
    >
  {:else if step.kind === "read" || step.kind === "links"}
    <span class={serif}>{title(step.source)}</span>
  {:else if step.kind === "search" && step.source.path !== null}
    <span class={serif}>{displayTitle(step.source.path, step.source.title)}</span>
    <span>for</span>
    <span class={serif}>“{step.source.label}”</span>
  {:else}
    <span class={serif}>“{topic(step.source.label) ?? step.source.label}”</span>
  {/if}
{/snippet}

{#snippet row(step: ResearchStep)}
  {@const now = active(step)}
  <li
    class="step relative animate-[slide-up_0.42s_cubic-bezier(0.25,1,0.5,1)_both] py-1"
    data-kind={step.kind}
    data-state={step.pending ? "pending" : now ? "active" : "done"}
  >
    <span class="node" aria-hidden="true"></span>
    <div class="flex min-h-[22px] flex-wrap items-baseline gap-x-[7px]">
      <span class={now ? "text-gold-muted" : ""}>{verb(step, now)}</span>
      {@render object(step)}
      {#if step.pending}
        <span class="inline-flex gap-0.5 self-center" aria-hidden="true">
          {#each [0, 1, 2] as dot (dot)}
            <i
              class="size-[3px] animate-[pulse-fade_1.1s_ease-in-out_infinite] rounded-full bg-gold-muted"
              style:animation-delay={`${dot * 140}ms`}
            ></i>
          {/each}
        </span>
      {:else if result(step)}
        <span
          class="animate-[pop-in_0.36s_ease_both] whitespace-nowrap text-gold-muted tabular-nums"
          >→ {result(step)}</span
        >
      {/if}
      {#if step.kind === "search" && step.source.path !== null && step.source.hits?.[0]}
        <span class="whitespace-nowrap tabular-nums">
          {step.source.hits[0].chunks
            .filter((chunk) => chunk >= 0)
            .map((chunk) => `§${chunk + 1}`)
            .join(", ")}
        </span>
      {/if}
    </div>
    {#if step.kind === "read"}
      <div class="mt-[3px] mb-0.5 flex items-center gap-2.5">
        <SourceStrip {step} reading={glowing(step)} />
        <span class="whitespace-nowrap tabular-nums">{readLabel(step)}</span>
      </div>
    {:else if step.kind === "search" && step.source.path === null && step.source.hits?.length}
      {@const shown = step.source.hits.slice(0, 3)}
      <ul
        class="flex flex-wrap gap-x-3.5 gap-y-px font-serif text-[length:var(--text-caption)] italic tracking-normal"
      >
        {#each shown as hit (hit.path)}
          {@const read = reads.some((step) => step.source.label === hit.path)}
          <li class={`animate-[pop-in_0.42s_ease_both] ${read ? "text-warm-dim" : ""}`}>
            {displayTitle(hit.path, hit.title)}{#if read}<span
                class="ml-1.5 font-mono text-[10px] text-gold-muted not-italic">· read</span
              >{/if}
          </li>
        {/each}
        {#if step.source.hits.length > shown.length}
          <li class="font-mono text-[10.5px] not-italic">
            +{step.source.hits.length - shown.length} more
          </li>
        {/if}
      </ul>
    {/if}
  </li>
{/snippet}

{#if steps.length > 0 || running}
  <section
    class={`${compact ? "mb-2.5" : "mb-7"} font-mono text-[length:var(--text-chrome)] leading-[1.7] tracking-[0.02em] text-warm-ghost`}
    aria-label="How this answer was researched"
  >
    {#if running && !answering}
      <div class="flex min-h-6 items-center gap-2.5" role="status">
        <span class="live relative size-[7px] shrink-0 rounded-full bg-gold" aria-hidden="true"
        ></span>
        <span class="relative h-[19px] min-w-0 flex-1 overflow-hidden">
          {#key statusKey}
            <span
              class="absolute inset-0 animate-[slide-up_0.32s_cubic-bezier(0.25,1,0.5,1)_both] truncate"
              >{status.lead}{#if status.object}&nbsp;<em class={serif}>{status.object}</em
                >{/if}</span
            >
          {/key}
        </span>
        {#if compact && focus}
          <SourceStrip step={focus} reading={glowing(focus)} width={56} />
        {/if}
        {#if steps.length > 0}
          <span class="whitespace-nowrap text-gold-muted tabular-nums"
            >{reads.length > 0 ? `${reads.length} read · ` : ""}{plural(steps.length, "step")}</span
          >
        {/if}
        {#if clock}<span class="tabular-nums">{clock}</span>{/if}
      </div>
    {:else if steps.length > 0}
      <div class="flex min-h-[30px] flex-wrap items-center gap-x-[18px] gap-y-2">
        <button
          type="button"
          class="inline-flex flex-wrap items-center gap-1.5 text-left hover:text-warm-faint"
          aria-expanded={!folded}
          onclick={() => (open = folded)}
        >
          {summary} <span aria-hidden="true">·</span>
          <span class="text-gold-muted tabular-nums">{plural(steps.length, "step")}</span>
          <ChevronRight
            size={11}
            class={`text-gold-muted transition-transform duration-300 ${folded ? "" : "rotate-90"}`}
          />
        </button>
        {#if reads.length > 0}
          <span
            class="inline-flex h-6 items-end gap-1 border-b border-ink-border pb-0.5"
            role="group"
            aria-label="Sources read"
          >
            {#each reads as step, index (step.source.label)}
              <svelte:element
                this={onOpen ? "button" : "span"}
                type={onOpen ? "button" : undefined}
                class="spine"
                data-kind={step.source.type}
                data-tip={`${title(step.source)} · ${readLabel(step)}`}
                aria-label={`${title(step.source)}, ${readLabel(step)}`}
                role={onOpen ? undefined : "img"}
                style:--fill={`${Math.round(fill(step) * 100)}%`}
                style:animation-delay={`${120 + index * 60}ms`}
                onclick={onOpen ? () => onOpen?.(step.source) : undefined}
              ></svelte:element>
            {/each}
          </span>
        {/if}
      </div>
    {/if}

    {#if steps.length > 0}
      <div
        class={`grid transition-[grid-template-rows,opacity] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] ${folded ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr]"}`}
      >
        <div class="min-h-0 overflow-hidden">
          <ol class="steps relative pt-1.5 pb-1 pl-[22px]">
            {#each rounds as round (round.key)}
              {#if round.note && !compact}
                <li
                  class="step note relative max-w-[60ch] py-1 font-serif text-[length:var(--text-caption)] italic tracking-normal"
                >
                  <span class="node" aria-hidden="true"></span><span class="line-clamp-3"
                    >{round.note}</span
                  >
                </li>
              {/if}
              {#if round.steps.length > 1}
                <li class="together">
                  <ol class="ml-0.5 border-l border-ink-subtle pl-3">
                    {#each round.steps as step (`${step.kind}:${step.source.label}`)}
                      {@render row(step)}
                    {/each}
                  </ol>
                </li>
              {:else}
                {@render row(round.steps[0]!)}
              {/if}
            {/each}
          </ol>
        </div>
      </div>
    {/if}
  </section>
{/if}

<style>
  .live::after,
  .step[data-state="pending"] .node::after,
  .step[data-state="active"] .node::after {
    content: "";
    position: absolute;
    inset: -4px;
    border-radius: 50%;
    border: 1px solid var(--gold);
    opacity: 0;
    animation: ring 1.8s cubic-bezier(0.25, 1, 0.5, 1) infinite;
  }
  .steps::before {
    content: "";
    position: absolute;
    top: 14px;
    bottom: 14px;
    left: 4px;
    width: 1px;
    background: var(--ink-subtle);
  }
  .node {
    position: absolute;
    top: 11px;
    left: -22px;
    width: 9px;
    height: 9px;
    border: 1px solid var(--ink-border);
    border-radius: 50%;
    background: var(--background);
    transition:
      background-color 300ms,
      border-color 300ms;
  }
  .step[data-kind="read"]:not([data-state="pending"]) .node {
    border-color: var(--gold);
    background: var(--gold);
  }
  .step[data-state="pending"] .node {
    border-color: var(--gold);
  }
  .together .node {
    left: -37px;
  }
  .note .node {
    top: 10px;
    left: -21px;
    width: 7px;
    height: 7px;
    border-radius: 1px;
    transform: rotate(45deg);
  }
  .spine {
    position: relative;
    width: 7px;
    height: 20px;
    border: 1px solid var(--ink-border);
    border-radius: 1px 1px 0 0;
    background: linear-gradient(
      to top,
      color-mix(in oklab, var(--gold) 70%, transparent) var(--fill),
      transparent var(--fill)
    );
    transform-origin: bottom;
    animation: shelve 520ms cubic-bezier(0.25, 1, 0.5, 1) both;
    transition:
      transform 200ms cubic-bezier(0.25, 1, 0.5, 1),
      border-color 200ms;
  }
  .spine[data-kind="raw"] {
    border-color: var(--gold-muted);
  }
  .spine:hover,
  .spine:focus-visible {
    transform: translateY(-3px);
    border-color: var(--gold);
  }
  .spine:hover::after,
  .spine:focus-visible::after {
    content: attr(data-tip);
    position: absolute;
    bottom: calc(100% + 8px);
    left: -10px;
    z-index: 10;
    width: max-content;
    max-width: 260px;
    padding: 5px 8px;
    border-radius: 2px;
    background: var(--foreground);
    color: var(--background);
    pointer-events: none;
  }
  @keyframes ring {
    from {
      transform: scale(0.4);
      opacity: 0.7;
    }
    to {
      transform: scale(1.7);
      opacity: 0;
    }
  }
  @keyframes shelve {
    from {
      opacity: 0;
      transform: scaleY(0.2);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    section :global(*),
    section :global(*::before),
    section :global(*::after) {
      animation-duration: 1ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 1ms !important;
    }
  }
</style>
