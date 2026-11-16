<script lang="ts">
  import { browser } from "$app/env";
  import { SvelteMap } from "svelte/reactivity";

  import { fetchChunks, type DocChunk } from "#lib/api/doc.ts";
  import { stripBlockRefMarkers } from "#lib/block-refs.ts";
  import type { Citation } from "#lib/citations.ts";
  import MarkdownView from "#lib/components/markdown-view.svelte";
  import { citedChunk } from "#lib/research-steps.ts";
  import { displayTitle } from "#lib/utils.ts";

  let {
    root,
    citations,
    panelDocked = false,
    sourceTitle,
    onOpen,
  }: {
    root: HTMLElement | null;
    citations: readonly Citation[];
    panelDocked?: boolean;
    sourceTitle?: (path: string) => string | null;
    onOpen: (citation: Citation) => void;
  } = $props();

  let wide = $state(false);
  let peek = $state<{ citation: Citation; top: number } | null>(null);
  let selected = $state<Citation | null>(null);
  const passages = new SvelteMap<string, DocChunk | null | "loading">();
  const margin = $derived(wide && !panelDocked);
  let leaving = 0;
  let marked: HTMLElement | null = null;

  $effect(() => {
    if (!browser) return;
    const width = window.matchMedia("(min-width: 1200px)");
    const coarse = window.matchMedia("(any-pointer: coarse)");
    const update = () => (wide = width.matches && !coarse.matches);
    update();
    width.addEventListener("change", update);
    coarse.addEventListener("change", update);
    return () => {
      width.removeEventListener("change", update);
      coarse.removeEventListener("change", update);
    };
  });

  const title = (citation: Citation) =>
    sourceTitle?.(citation.path) ?? displayTitle(citation.path, null);

  const load = (citation: Citation) => {
    const chunk = citedChunk(citation.href);
    if (chunk === null || passages.has(citation.href)) return;
    passages.set(citation.href, "loading");
    fetchChunks(citation.path, chunk, chunk).then(
      (chunks) => passages.set(citation.href, chunks[0] ?? null),
      () => passages.set(citation.href, null),
    );
  };

  const mark = (element: HTMLElement | null) => {
    marked?.removeAttribute("data-peeking");
    marked = element;
    marked?.setAttribute("data-peeking", "");
  };

  const linkOf = (element: HTMLElement) => {
    const link = element.matches("a") ? element : element.closest("sup")?.previousElementSibling;
    return link instanceof HTMLElement ? link : element;
  };
  const cited = (citation: Citation, element: HTMLElement): Citation => ({
    ...citation,
    href: linkOf(element).getAttribute("href") ?? citation.href,
  });

  const show = (citation: Citation, element: HTMLElement, current: HTMLElement) => {
    clearTimeout(leaving);
    mark(linkOf(element));
    peek = {
      citation: cited(citation, element),
      top: element.getBoundingClientRect().top - current.getBoundingClientRect().top - 4,
    };
    load(peek.citation);
  };

  const hide = () => {
    clearTimeout(leaving);
    leaving = window.setTimeout(() => {
      peek = null;
      mark(null);
    }, 220);
  };

  $effect(() => {
    const current = root;
    if (!current) return;
    const target = (event: Event) =>
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("a[data-citation], [data-citation-ref]")
        : null;
    const citationOf = (element: HTMLElement) => {
      const n = element.dataset.citation ?? element.dataset.citationRef;
      return citations.find((citation) => String(citation.n) === n);
    };
    const enter = (event: Event) => {
      const element = target(event);
      const citation = element && citationOf(element);
      if (margin && element && citation) show(citation, element, current);
    };
    const leave = (event: MouseEvent | FocusEvent) => {
      const element = target(event);
      if (!margin || !element) return;
      if (event.relatedTarget instanceof Node && element.contains(event.relatedTarget)) return;
      hide();
    };
    const click = (event: MouseEvent) => {
      const element = target(event);
      const citation = element && citationOf(element);
      if (!element || !citation) return;
      event.preventDefault();
      event.stopPropagation();
      if (margin) {
        clearTimeout(leaving);
        peek = null;
        mark(null);
        onOpen(cited(citation, element));
      } else {
        selected = cited(citation, element);
        load(selected);
      }
    };
    current.addEventListener("mouseover", enter);
    current.addEventListener("mouseout", leave);
    current.addEventListener("focusin", enter);
    current.addEventListener("focusout", leave);
    current.addEventListener("click", click);
    return () => {
      current.removeEventListener("mouseover", enter);
      current.removeEventListener("mouseout", leave);
      current.removeEventListener("focusin", enter);
      current.removeEventListener("focusout", leave);
      current.removeEventListener("click", click);
      clearTimeout(leaving);
      mark(null);
    };
  });

  $effect(() => {
    if (margin) selected = null;
    else peek = null;
  });

  function dismiss(event: MouseEvent) {
    if (!selected) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("[data-citation-card], [data-citation-ref], a[data-citation]")) return;
    selected = null;
  }
</script>

<svelte:window
  onclick={dismiss}
  onkeydown={(event) => {
    if (event.key !== "Escape") return;
    selected = null;
    peek = null;
    mark(null);
  }}
/>

{#snippet source(citation: Citation)}
  {@const passage = passages.get(citation.href)}
  <div class="font-serif text-[length:var(--text-small)] leading-[1.45] text-warm">
    <span class="mr-1.5 font-mono text-[10px] text-gold">{citation.n}</span>{title(citation)}
  </div>
  {#if passage === "loading"}
    <div
      class="mt-2 h-10 animate-[pulse-fade_1.6s_ease-in-out_infinite] rounded-sm bg-ink-raised"
    ></div>
  {:else if passage}
    <div
      class="relative mt-2 max-h-[13.5em] overflow-hidden text-[length:var(--text-caption)] leading-[1.6] text-warm-dim after:absolute after:inset-x-0 after:bottom-0 after:h-6 after:bg-gradient-to-t after:from-ink-panel"
    >
      <MarkdownView source={stripBlockRefMarkers(passage.body)} variant="panel" />
    </div>
  {/if}
  <div
    class="mt-2 flex items-center justify-between font-mono text-[10px] tracking-[0.1em] text-warm-ghost uppercase"
  >
    <span
      >{citation.kind}{passage && passage !== "loading"
        ? ` · §${passage.chunk_index + 1}`
        : ""}</span
    >
    <button
      type="button"
      onclick={() => {
        const opening = citation;
        selected = null;
        peek = null;
        mark(null);
        onOpen(opening);
      }}
      class="text-gold-muted underline decoration-gold-dim underline-offset-[3px] hover:text-gold"
      >open</button
    >
  </div>
{/snippet}

{#if margin && peek}
  <aside
    data-citation-peek
    aria-label={`source ${peek.citation.n}`}
    class="absolute left-[calc(100%+2rem)] z-10 w-[clamp(180px,calc((100vw-740px)/2-3rem),300px)] animate-[pop-in_0.22s_cubic-bezier(0.25,1,0.5,1)_both] rounded-sm border border-ink-border bg-ink-panel px-3.5 pt-3 pb-2.5 shadow-[0_8px_28px_rgba(40,30,10,0.14)] print:hidden"
    style:top={`${peek.top}px`}
    onmouseenter={() => clearTimeout(leaving)}
    onmouseleave={hide}
  >
    {@render source(peek.citation)}
  </aside>
{/if}

{#if citations.length > 0}
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
            <span class="pt-0.5 font-mono text-[10px] text-gold">{citation.n}</span>
            <span class="[overflow-wrap:anywhere]">{title(citation)}</span>
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
    class="fixed inset-x-3 bottom-[calc(6.5rem+env(safe-area-inset-bottom))] z-[150] rounded-md border border-ink-border bg-ink-panel px-4 pt-3.5 pb-3 shadow-[0_10px_30px_rgba(40,30,10,0.18)] md:inset-x-auto md:left-1/2 md:w-[420px] md:-translate-x-1/2"
  >
    {@render source(selected)}
  </div>
{/if}
