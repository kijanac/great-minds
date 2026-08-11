<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";

  let {
    pending,
    error,
    onOpen,
  }: {
    pending: boolean;
    error: string | null;
    onOpen: (url: string) => Promise<void>;
  } = $props();

  let url = $state("");

  function submit(event: SubmitEvent) {
    event.preventDefault();
    const value = url.trim();
    if (value) void onOpen(value);
  }
</script>

<form onsubmit={submit} class="mb-8">
  <div class="flex gap-2">
    <Input
      value={url}
      oninput={(event) => (url = event.currentTarget.value)}
      inputmode="url"
      autocomplete="url"
      placeholder="Paste an article URL"
      aria-label="External article URL"
      required
      disabled={pending}
      class="h-9 rounded-sm border-ink-border bg-transparent px-3 font-serif text-[length:var(--text-small)] text-foreground caret-gold placeholder:text-input focus-visible:border-gold-dim focus-visible:ring-0 dark:bg-transparent"
    />
    <Button
      type="submit"
      disabled={pending || !url.trim()}
      class="h-9 rounded-sm px-4 font-mono text-[length:var(--text-chrome)] tracking-[0.08em]"
    >
      {pending ? "opening…" : "open"}
    </Button>
  </div>
  {#if error}
    <p
      class="mt-2 font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-destructive"
    >
      {error}
    </p>
  {/if}
</form>
