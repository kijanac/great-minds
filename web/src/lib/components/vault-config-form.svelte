<script lang="ts" module>
  export interface VaultConfigFormSubmit {
    name?: string;
    thematic_hint: string;
  }
</script>

<script lang="ts">
  import { draftThematicHint } from "$lib/api/vaults";
  import { Alert, AlertDescription } from "$lib/components/ui/alert";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Textarea } from "$lib/components/ui/textarea";

  let {
    mode,
    initialName = "",
    initialThematicHint = "",
    submitting = false,
    onSubmit,
    onCancel,
    submitLabel,
  }: {
    mode: "create" | "edit";
    initialName?: string;
    initialThematicHint?: string;
    submitting?: boolean;
    onSubmit: (data: VaultConfigFormSubmit) => Promise<void> | void;
    onCancel?: () => void;
    submitLabel?: string;
  } = $props();

  const SECTION_LABEL =
    "mb-2 block font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-gold-muted uppercase";

  // svelte-ignore state_referenced_locally - form state intentionally snapshots initial props
  let name = $state(initialName);
  let description = $state("");
  // svelte-ignore state_referenced_locally - form state intentionally snapshots initial props
  let thematicHint = $state(initialThematicHint);
  let drafting = $state(false);
  let draftError = $state<string | null>(null);

  const isCreate = $derived(mode === "create");
  const canSubmit = $derived(
    !submitting && (!isCreate || name.trim().length > 0),
  );

  async function draft() {
    const trimmed = description.trim();
    if (!trimmed || drafting) return;
    draftError = null;
    drafting = true;
    try {
      thematicHint = await draftThematicHint(trimmed);
    } catch (error) {
      draftError = error instanceof Error ? error.message : "Failed to draft";
    } finally {
      drafting = false;
    }
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    await onSubmit({
      name: isCreate ? name.trim() : undefined,
      thematic_hint: thematicHint,
    });
  }
</script>

<form onsubmit={submit} class="space-y-8">
  {#if isCreate}
    <div>
      <Label for="vault-name" class={SECTION_LABEL}>project name</Label>
      <Input
        id="vault-name"
        bind:value={name}
        autofocus
        disabled={submitting}
        placeholder="untitled"
        class="h-auto rounded-sm border-input bg-secondary px-[14px] py-[10px] font-serif text-[length:var(--text-body)] text-foreground caret-gold placeholder:text-warm-ghost focus-visible:border-ring focus-visible:ring-0 disabled:opacity-60 dark:bg-secondary"
      />
    </div>
  {/if}

  <div>
    <Label for="vault-description" class={SECTION_LABEL}>
      describe what to focus on
      <span class="ml-2 text-warm-ghost normal-case tracking-normal">
        (optional, used to draft a focus statement)
      </span>
    </Label>
    <Textarea
      id="vault-description"
      bind:value={description}
      disabled={submitting || drafting}
      placeholder="e.g. a knowledge base on Marxist political economy, with emphasis on debates and events over biography"
      rows={3}
      class="rounded-sm font-serif text-[length:var(--text-body)] text-foreground placeholder:text-warm-ghost focus-visible:ring-0"
    />
    <div class="mt-2 flex items-center gap-3">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onclick={() => void draft()}
        disabled={!description.trim() || drafting || submitting}
        class="border-ink-border font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-warm-faint hover:border-gold-dim hover:text-gold"
      >
        {drafting ? "drafting…" : "draft focus from description"}
      </Button>
      {#if draftError}
        <Alert
          variant="destructive"
          class="rounded-sm border-red-400/25 bg-red-400/5 py-1.5"
        >
          <AlertDescription
            class="font-mono text-[length:var(--text-chrome)] text-red-400/90"
          >
            {draftError}
          </AlertDescription>
        </Alert>
      {/if}
    </div>
  </div>

  <div>
    <Label for="vault-thematic-hint" class={SECTION_LABEL}>
      editorial focus
      <span class="ml-2 text-warm-ghost normal-case tracking-normal">
        (steers how topics are framed; leave blank to use defaults)
      </span>
    </Label>
    <Textarea
      id="vault-thematic-hint"
      bind:value={thematicHint}
      disabled={submitting}
      placeholder="prefer event-centric and debate-centric framings over biographical summaries"
      rows={5}
      class="rounded-sm font-serif text-[length:var(--text-body)] text-foreground placeholder:text-warm-ghost focus-visible:ring-0"
    />
  </div>

  <div class="flex items-center gap-3 pt-2">
    <Button
      type="submit"
      disabled={!canSubmit}
      class="rounded-sm border border-gold-dim bg-gold/15 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-gold hover:bg-gold/25"
    >
      {submitting
        ? "saving…"
        : (submitLabel ?? (isCreate ? "create project" : "save changes"))}
    </Button>
    {#if onCancel}
      <Button
        type="button"
        variant="ghost"
        onclick={onCancel}
        disabled={submitting}
        class="font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-warm-ghost hover:bg-transparent hover:text-warm"
      >
        cancel
      </Button>
    {/if}
  </div>
</form>
