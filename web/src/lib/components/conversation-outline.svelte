<script lang="ts">
  import type { OutlineEntry } from "#lib/citations.ts";

  let {
    entries,
    active,
    touch = false,
    onJump,
  }: {
    entries: readonly OutlineEntry[];
    active: number;
    touch?: boolean;
    onJump: (entry: OutlineEntry) => void;
  } = $props();
</script>

{#each entries as entry, index (`${entry.id}:${entry.heading}:${index}`)}
  <button
    type="button"
    onclick={() => onJump(entry)}
    aria-current={index === active ? "location" : undefined}
    class={[
      "block w-full border-l pl-2.5 text-left transition-colors [overflow-wrap:anywhere] hover:border-gold hover:text-warm",
      touch ? "py-2" : "py-1",
      entry.question && "mt-3 italic",
      index === active
        ? "border-gold text-warm"
        : entry.question
          ? "border-ink-border text-warm-faint"
          : "border-ink-subtle text-warm-ghost",
    ]}>{entry.label}</button
  >
{/each}
