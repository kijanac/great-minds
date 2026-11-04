<script lang="ts">
  import { browser } from "$app/environment";
  import { tick } from "svelte";

  import type { Citation } from "$lib/citations";

  let {
    root,
    citations,
    panelDocked = false,
    onOpen,
  }: {
    root: HTMLElement | null;
    citations: readonly Citation[];
    panelDocked?: boolean;
    onOpen: (citation: Citation) => void;
  } = $props();

  let wide = $state(false);
  let positions = $state<Record<number, number>>({});
  let selected = $state<Citation | null>(null);
  const margin = $derived(wide && !panelDocked);

  $effect(() => {
    if (!browser) return;
    const query = window.matchMedia("(min-width: 1200px)");
    const update = () => (wide = query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  });

  $effect(() => {
    const current = root;
    const enabled = margin;
    const list = citations;
    if (!current || !enabled || list.length === 0) {
      positions = {};
      return;
    }
    let frame = 0;
    const place = async () => {
      await tick();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rootTop = current.getBoundingClientRect().top;
        const next: Record<number, number> = {};
        let cursor = 0;
        for (const citation of list) {
          const ref = current.querySelector<HTMLElement>(
            `[data-citation-ref="${citation.n}"]`,
          );
          const block = ref?.closest<HTMLElement>("[data-block-offset]") ?? ref;
          const note = current.querySelector<HTMLElement>(
            `[data-citation-note="${citation.n}"]`,
          );
          if (!block || !note) continue;
          const top = Math.max(
            block.getBoundingClientRect().top - rootTop,
            cursor,
          );
          next[citation.n] = top;
          cursor = top + note.getBoundingClientRect().height + 10;
        }
        positions = next;
      });
    };
    void place();
    const observer = new ResizeObserver(() => void place());
    observer.observe(current);
    window.addEventListener("resize", place);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", place);
    };
  });

  $effect(() => {
    const current = root;
    if (!current) return;
    const click = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const ref = target?.closest<HTMLElement>("[data-citation-ref]");
      if (!ref || !current.contains(ref)) return;
      event.preventDefault();
      event.stopPropagation();
      const citation = citations.find(
        (candidate) => String(candidate.n) === ref.dataset.citationRef,
      );
      if (!citation) return;
      if (margin) onOpen(citation);
      else selected = citation;
    };
    current.addEventListener("click", click);
    return () => current.removeEventListener("click", click);
  });

  function dismiss(event: MouseEvent) {
    if (!selected) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("[data-citation-card], [data-citation-ref]")) return;
    selected = null;
  }
</script>

<svelte:window
  onclick={dismiss}
  onkeydown={(event) => {
    if (event.key === "Escape") selected = null;
  }}
/>

{#snippet kind(citation: Citation)}
  <span class="font-mono text-[9px] tracking-[0.1em] text-warm-ghost uppercase"
    >{citation.kind}</span
  >
{/snippet}

{#if margin}
  <div class="pointer-events-none absolute inset-0 print:hidden">
    {#each citations as citation (citation.n)}
      <button
        type="button"
        data-citation-note={citation.n}
        onclick={() => onOpen(citation)}
        class={`pointer-events-auto absolute left-[calc(100%+2rem)] grid w-[clamp(150px,calc((100vw-740px)/2-3rem),220px)] grid-cols-[14px_1fr] gap-x-1.5 text-left font-serif text-[length:var(--text-caption)] leading-[1.5] text-warm-faint transition-opacity hover:text-warm-dim ${citation.n in positions ? "opacity-100" : "opacity-0"}`}
        style:top={`${positions[citation.n] ?? 0}px`}
      >
        <span class="pt-0.5 font-mono text-[10px] text-gold">{citation.n}</span>
        <span class="[overflow-wrap:anywhere]">{citation.label}</span>
        <span class="col-start-2">{@render kind(citation)}</span>
      </button>
    {/each}
  </div>
{:else if citations.length > 0}
  <details class="mt-6 group">
    <summary
      class="cursor-pointer list-none font-mono text-[10px] tracking-[0.14em] text-gold-muted uppercase marker:hidden [&::-webkit-details-marker]:hidden"
    >
      {citations.length}
      {citations.length === 1 ? "source" : "sources"}
    </summary>
    <ol class="mt-2.5 space-y-1.5">
      {#each citations as citation (citation.n)}
        <li>
          <button
            type="button"
            onclick={() => onOpen(citation)}
            class="grid w-full grid-cols-[18px_1fr] gap-x-1.5 text-left font-serif text-[length:var(--text-caption)] leading-[1.55] text-warm-faint hover:text-warm-dim"
          >
            <span class="pt-0.5 font-mono text-[10px] text-gold"
              >{citation.n}</span
            >
            <span class="[overflow-wrap:anywhere]">{citation.label}</span>
          </button>
        </li>
      {/each}
    </ol>
  </details>
{/if}

{#if selected && !margin}
  <div
    data-citation-card
    role="dialog"
    aria-label={`source ${selected.n}`}
    class="fixed inset-x-3 bottom-[calc(6.5rem+env(safe-area-inset-bottom))] z-[150] rounded-md border border-ink-border bg-ink-raised px-4 pt-3.5 pb-3 shadow-[0_10px_30px_rgba(40,30,10,0.18)] md:inset-x-auto md:left-1/2 md:w-[420px] md:-translate-x-1/2"
  >
    <div
      class="font-serif text-[length:var(--text-small)] leading-[1.5] text-warm"
    >
      <span class="mr-1.5 font-mono text-[10px] text-gold">{selected.n}</span
      >{selected.label}
    </div>
    <div class="mt-2.5 flex items-center justify-between">
      {@render kind(selected)}
      <button
        type="button"
        onclick={() => {
          if (selected) onOpen(selected);
          selected = null;
        }}
        class="font-mono text-[10px] tracking-[0.1em] text-gold-muted uppercase underline decoration-gold-dim underline-offset-[3px] hover:text-gold"
        >open</button
      >
    </div>
  </div>
{/if}
