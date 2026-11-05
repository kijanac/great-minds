<script lang="ts">
  import type { OutcomeArticle, RunOutcome } from "@great-minds/domain";
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
    stopped === null &&
      outcome !== null &&
      outcome.unchanged === 0 &&
      outcome.changed.length === 0 &&
      outcome.added.length > 0,
  );
  const nothing = $derived(
    outcome !== null &&
      outcome.added.length === 0 &&
      outcome.changed.length === 0 &&
      outcome.removed.length === 0,
  );
  const startHere = createQuery(() => ({
    queryKey: ["run-outcome-start-here"],
    queryFn: () => fetchWikiArticles({ sort: "linked", limit: 3 }),
    enabled: firstBuild,
  }));

  const plural = (count: number, word: string) =>
    `${count.toLocaleString("en-US")} ${word}${count === 1 ? "" : "s"}`;

  const title = $derived.by(() => {
    if (stopped !== null)
      return stopped.kind === "cancelled"
        ? "Update cancelled"
        : stopped.stage === null
          ? "Update stopped"
          : `Update stopped while ${stopped.stage.toLowerCase()}`;
    if (outcome === null) return "Update finished";
    if (firstBuild)
      return `Your library has ${plural(outcome.added.length, "article")}`;
    if (nothing) return "Nothing changed";
    const parts = [
      outcome.added.length > 0
        ? plural(outcome.added.length, "new article")
        : "",
      outcome.changed.length > 0 ? `${outcome.changed.length} updated` : "",
      outcome.removed.length > 0 ? `${outcome.removed.length} removed` : "",
    ].filter((part) => part !== "");
    return parts.join(", ");
  });
</script>

{#snippet group(
  key: string,
  label: string,
  articles: readonly OutcomeArticle[],
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
                class="block py-1.5 font-serif text-[length:var(--text-body)] leading-[1.5] text-warm-faint [overflow-wrap:anywhere]"
                >{article.title}</span
              >
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
