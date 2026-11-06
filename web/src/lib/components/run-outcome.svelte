<script lang="ts">
  import type { RemovedArticle, RunOutcome } from "@great-minds/domain";
  import {
    changedNothing,
    isFirstBuild,
    outcomeHeadline,
    plural,
    stoppedHeadline,
  } from "@great-minds/client";
  import { createQuery } from "@tanstack/svelte-query";
  import type { Snippet } from "svelte";

  import { fetchWikiArticles } from "$lib/api/wiki";

  let {
    outcome,
    onOpen,
    stopped = null,
    actions,
  }: {
    outcome: RunOutcome | null;
    onOpen: (filePath: string) => void;
    stopped?: {
      readonly kind: "failed" | "cancelled";
      readonly stage: string | null;
    } | null;
    actions?: Snippet;
  } = $props();

  const LIMIT = 5;
  let expanded = $state<Record<string, boolean>>({});

  const firstBuild = $derived(
    stopped === null && outcome !== null && isFirstBuild(outcome),
  );
  const nothing = $derived(outcome !== null && changedNothing(outcome));
  const startHere = createQuery(() => ({
    queryKey: ["run-outcome-start-here"],
    queryFn: () => fetchWikiArticles({ sort: "linked", limit: 3 }),
    enabled: firstBuild,
  }));

  const title = $derived.by(() => {
    if (stopped !== null) return stoppedHeadline(stopped.kind, stopped.stage);
    if (outcome === null) return "Update finished";
    return outcomeHeadline(outcome);
  });
</script>

{#snippet group(
  key: string,
  label: string,
  articles: readonly RemovedArticle[],
)}
  {#if articles.length > 0}
    {@const shown = expanded[key] ? articles : articles.slice(0, LIMIT)}
    <section class="mb-6">
      <h2
        class="mb-2 font-mono text-[10px] font-medium tracking-[0.14em] text-gold-muted uppercase"
      >
        {label}
      </h2>
      <ul>
        {#each shown as article (article.file_path)}
          <li class="border-t border-ink-subtle">
            {#if article.file_path.startsWith("wiki/")}
              <button
                type="button"
                onclick={() => onOpen(article.file_path)}
                class="w-full py-1.5 text-left font-serif text-[length:var(--text-body)] leading-[1.5] text-warm-dim hover:text-warm [overflow-wrap:anywhere]"
                >{article.title}</button
              >
            {:else}
              <span
                class="block pt-1.5 font-serif text-[length:var(--text-body)] leading-[1.5] text-warm-faint [overflow-wrap:anywhere] {article.merged_into
                  ? ''
                  : 'pb-1.5'}">{article.title}</span
              >
              {#if article.merged_into}
                {@const into = article.merged_into}
                <button
                  type="button"
                  onclick={() => onOpen(into.file_path)}
                  class="block pb-1.5 text-left font-mono text-[length:var(--text-chrome)] text-warm-ghost hover:text-gold [overflow-wrap:anywhere]"
                  >merged into {into.title}</button
                >
              {/if}
            {/if}
          </li>
        {/each}
        {#if articles.length > LIMIT && !expanded[key]}
          <li class="border-t border-ink-subtle">
            <button
              type="button"
              onclick={() => (expanded = { ...expanded, [key]: true })}
              class="py-1.5 font-mono text-[length:var(--text-chrome)] text-gold-muted hover:text-gold"
              >show all {articles.length}</button
            >
          </li>
        {/if}
      </ul>
    </section>
  {/if}
{/snippet}

<h1
  class="mt-1 mb-6 font-serif text-[length:var(--text-title)] leading-[1.25] text-warm"
>
  {title}
</h1>
{@render actions?.()}
{#if !stopped && outcome && !firstBuild && !nothing && outcome.sources > 0}
  <p
    class="-mt-4 mb-7 font-serif text-[length:var(--text-body)] leading-[1.7] text-warm-faint"
  >
    From {plural(outcome.sources, "new or edited source")}.
  </p>
{/if}

{#if outcome}
  {#if firstBuild}
    {@render group(
      "start",
      "Start with",
      (startHere.data?.items ?? []).map((article) => ({
        title: article.title,
        file_path: article.file_path,
      })),
    )}
  {:else}
    {@render group("added", "New", outcome.added)}
    {@render group("changed", "Updated", outcome.changed)}
    {@render group("removed", "Removed", outcome.removed)}
  {/if}
{/if}
