<script lang="ts">
  import Maximize2 from "@lucide/svelte/icons/maximize-2";
  import X from "@lucide/svelte/icons/x";

  import { Button } from "#lib/components/ui/button/index.ts";
  import { Skeleton } from "#lib/components/ui/skeleton/index.ts";
  import MarkdownView from "#lib/components/markdown-view.svelte";
  import SourceStrip from "#lib/components/source-strip.svelte";
  import type { PanelContent } from "#lib/panel-content.ts";
  import { readLabel, type ReadingTrail } from "#lib/research-steps.ts";
  import type { SourceRef } from "#lib/types.ts";
  import { displayTitle } from "#lib/utils.ts";

  let {
    card,
    trail = null,
    content,
    loading,
    context = "agent",
    onClose,
    onFullScreen,
    onOpenPath,
    onLinkClick,
  }: {
    card: SourceRef;
    trail?: ReadingTrail | null;
    content: PanelContent | null;
    loading: boolean;
    // "agent" = opened from a session's source cards (the agent's context);
    // "citation" = opened from a citation in an article body.
    context?: "agent" | "citation";
    onClose: () => void;
    onFullScreen: () => void;
    onOpenPath: (path: string) => void;
    onLinkClick: (event: MouseEvent) => void;
  } = $props();

  // Citation-opened cards carry no wire title; the chunk heading is the
  // document's own heading and reads far better than a hashed path.
  const headingTitle = $derived(
    displayTitle(
      card.label,
      card.title ?? (content?.mode === "chunks" ? (content.chunks[0]?.heading ?? null) : null),
    ),
  );
  const subtitle = $derived.by(() => {
    if (card.type === "links") return "connections the agent saw";
    if (trail) return `read · ${readLabel(trail.step)}`;
    if (content?.mode === "chunks") {
      const ranges = (card.ranges ?? [])
        .map((range) =>
          range.start === range.end
            ? `§${range.start + 1}`
            : `§${range.start + 1}–${range.end + 1}`,
        )
        .join(", ");
      const label = context === "citation" ? "cited passage" : "what the agent read";
      return ranges ? `${ranges} · ${label}` : label;
    }
    const kind = card.label.startsWith("wiki/") ? "wiki article" : "raw source";
    return `${kind} · full document`;
  });
  const sections = (index: number) => `§${index + 1}`;
  const span = (from: number, to: number) =>
    from === to ? sections(from) : `${sections(from)}–${sections(to)}`;
  const passages = $derived.by(() => {
    if (content?.mode !== "chunks") return [];
    const total = trail?.step.source.chunks;
    const items: (
      | { kind: "gap"; from: number; to: number }
      | { kind: "passage"; chunk: (typeof content.chunks)[number] }
    )[] = [];
    let next = 0;
    for (const chunk of content.chunks) {
      if (trail && chunk.chunk_index > next)
        items.push({ kind: "gap", from: next, to: chunk.chunk_index - 1 });
      items.push({ kind: "passage", chunk });
      next = chunk.chunk_index + 1;
    }
    if (trail && total !== undefined && next < total)
      items.push({ kind: "gap", from: next, to: total - 1 });
    return items;
  });
  let body: HTMLDivElement | undefined = $state();
  const jump = (section: number, behavior: ScrollBehavior = "smooth") => {
    const gaps = [...(body?.querySelectorAll<HTMLElement>("[data-gap-from]") ?? [])];
    const target =
      body?.querySelector(`#panel-passage-${section}`) ??
      gaps.find(
        (gap) => Number(gap.dataset.gapFrom) <= section && section <= Number(gap.dataset.gapTo),
      ) ??
      body?.querySelector(`[id="^p${section}"]`);
    target?.scrollIntoView({ block: "center", behavior });
  };
  $effect(() => {
    const focus = trail?.focus;
    if (focus === null || focus === undefined || passages.length === 0) return;
    requestAnimationFrame(() => jump(focus, "instant"));
  });
</script>

<div class="flex h-full flex-col">
  <div class="shrink-0 border-b border-ink-subtle px-5 pt-5 pb-3.5">
    <div class="mb-[9px] flex items-start justify-between gap-2">
      <span class="min-w-0 break-words text-[length:var(--text-body)] font-bold text-foreground">
        {headingTitle}
      </span>
      <div class="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="icon-xs"
          onclick={onFullScreen}
          class="shrink-0 text-muted-foreground hover:bg-transparent hover:text-gold"
          title="Open full screen"
          aria-label="open full screen"
        >
          <Maximize2 size={12} />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          onclick={onClose}
          class="shrink-0 text-muted-foreground hover:bg-transparent hover:text-warm-faint"
          aria-label="close article panel"
        >
          <X size={14} />
        </Button>
      </div>
    </div>
    <span
      title={card.label}
      class="font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-warm-ghost uppercase"
    >
      {subtitle}
    </span>
    {#if trail}
      <dl
        class="mt-2.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-[length:var(--text-chrome)] leading-relaxed text-warm-ghost"
      >
        {#if trail.found}
          <dt class="text-warm-faint">found</dt>
          <dd>
            by searching <em class="font-serif text-[length:var(--text-caption)]"
              >“{trail.found.label}”</em
            >
          </dd>
        {/if}
        {#each trail.within as search, index (index)}
          <dt class="text-warm-faint">searched</dt>
          <dd>
            within it for <em class="font-serif text-[length:var(--text-caption)]"
              >“{search.label}”</em
            >
            → {(search.hits?.[0]?.chunks ?? [])
              .filter((chunk) => chunk >= 0)
              .map(sections)
              .join(", ") || "no passages"}
          </dd>
        {/each}
        {#if trail.cited.size > 0}
          <dt class="text-warm-faint">cited</dt>
          <dd>
            {[...trail.cited].map(([chunk, n]) => `[${n}] at ${sections(chunk)}`).join(", ")}
          </dd>
        {/if}
      </dl>
      {#if trail.step.source.chunks}
        <div class="mt-3"><SourceStrip step={trail.step} width={360} onPick={jump} /></div>
      {/if}
    {/if}
  </div>

  <div bind:this={body} class="min-h-0 flex-1 overflow-y-auto">
    <div class="px-5 py-[18px]">
      {#if loading}
        <div class="space-y-3">
          <Skeleton class="h-4 w-full bg-ink-raised" />
          <Skeleton class="h-4 w-11/12 bg-ink-raised" />
          <Skeleton class="h-4 w-4/5 bg-ink-raised" />
          <Skeleton class="h-4 w-2/3 bg-ink-raised" />
        </div>
      {:else if content?.mode === "doc"}
        <MarkdownView
          source={content.body}
          variant="panel"
          stripBlockRefs
          resolveBlockRefs={trail !== null}
          {onLinkClick}
        />
      {:else if content?.mode === "chunks"}
        <div class="space-y-2">
          {#if content.chunks.length === 0}
            <p class="text-[length:var(--text-small)] text-warm-faint">No passages found.</p>
          {:else}
            {#each passages as item, index (item.kind === "gap" ? `gap:${item.from}` : item.chunk.chunk_index)}
              {#if item.kind === "gap"}
                <div
                  data-gap-from={item.from}
                  data-gap-to={item.to}
                  class="flex items-center gap-3 py-1 font-mono text-[length:var(--text-chrome)] text-warm-ghost before:h-px before:flex-1 before:border-t before:border-dashed before:border-ink-border after:h-px after:flex-1 after:border-t after:border-dashed after:border-ink-border"
                >
                  {span(item.from, item.to)} · not read
                </div>
              {:else}
                {@const cited = trail?.cited.get(item.chunk.chunk_index)}
                <section
                  id={`panel-passage-${item.chunk.chunk_index}`}
                  class={`-mx-2.5 animate-[pop-in_0.5s_cubic-bezier(0.25,1,0.5,1)_both] rounded-sm px-2.5 py-2 ${trail ? (cited ? "bg-[color-mix(in_oklab,var(--gold)_14%,transparent)]" : "bg-[color-mix(in_oklab,var(--gold)_6%,transparent)]") : ""}`}
                  style:animation-delay={`${Math.min(index, 8) * 90}ms`}
                >
                  <div
                    class="mb-1 font-mono text-[length:var(--text-chrome)] tracking-[0.08em] text-gold-muted"
                  >
                    {sections(item.chunk.chunk_index)}{item.chunk.heading
                      ? ` · ${item.chunk.heading}`
                      : ""}{cited ? ` · cited as [${cited}]` : ""}
                  </div>
                  <MarkdownView
                    source={item.chunk.body}
                    variant="panel"
                    stripBlockRefs
                    {onLinkClick}
                  />
                </section>
              {/if}
            {/each}
          {/if}
        </div>
      {:else if content?.mode === "outline"}
        <p class="text-[length:var(--text-small)] leading-relaxed text-warm-faint">
          The agent read only this document's outline, not its text.
        </p>
      {:else if content?.mode === "links"}
        <div class="space-y-5">
          {#each [{ label: "cites →", items: content.links.outgoing }, { label: "cited by ←", items: content.links.incoming }] as group (group.label)}
            <div>
              <div
                class="mb-2 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-interactive-dim uppercase"
              >
                {group.label}
              </div>
              {#if group.items.length === 0}
                <p class="text-[length:var(--text-small)] text-warm-ghost italic">none</p>
              {:else}
                <ul class="space-y-1">
                  {#each group.items as item (item.file_path)}
                    <li>
                      <button
                        type="button"
                        onclick={() => onOpenPath(item.file_path)}
                        class="text-left text-[length:var(--text-small)] text-warm-dim transition-colors hover:text-gold"
                      >
                        {item.title}
                      </button>
                    </li>
                  {/each}
                </ul>
              {/if}
            </div>
          {/each}
        </div>
      {:else}
        <p class="text-[length:var(--text-small)] text-warm-faint">Not found.</p>
      {/if}
    </div>
  </div>
</div>
