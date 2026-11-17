<script lang="ts">
  import { goto } from "$app/navigation";
  import Check from "@lucide/svelte/icons/check";
  import Link from "@lucide/svelte/icons/link";

  import { copyPassageLink } from "#lib/passage-navigation.ts";

  let { root }: { root: HTMLElement | undefined } = $props();

  let block = $state<HTMLElement | null>(null);
  let top = $state(0);
  let copied = $state(false);
  let timer = 0;

  $effect(() => {
    const current = root;
    if (!current) return;
    const over = (event: MouseEvent) => {
      const found =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>("[data-block-offset][id]")
          : null;
      if (!found || found === block || !current.contains(found)) return;
      block = found;
      copied = false;
      top = found.getBoundingClientRect().top - current.getBoundingClientRect().top;
    };
    const leave = () => (block = null);
    current.addEventListener("mouseover", over);
    current.addEventListener("mouseleave", leave);
    return () => {
      current.removeEventListener("mouseover", over);
      current.removeEventListener("mouseleave", leave);
      clearTimeout(timer);
    };
  });

  async function copy() {
    if (!block) return;
    const hash = `#${block.id}`;
    await copyPassageLink(hash);
    copied = true;
    clearTimeout(timer);
    timer = window.setTimeout(() => (copied = false), 1500);
    void goto(hash, { replace: true, reset: false });
  }
</script>

{#if block}
  <button
    type="button"
    title="Copy link"
    aria-label="Copy link to this passage"
    onclick={copy}
    style:top={`${top + 4}px`}
    class="absolute left-2 hidden size-6 cursor-pointer items-center justify-center text-warm-ghost hover:text-gold md:flex"
  >
    {#if copied}<Check size={13} />{:else}<Link size={13} />{/if}
  </button>
{/if}
