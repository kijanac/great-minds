<script lang="ts">
  import { promoteExchange, type PromoteResult } from "$lib/api/sessions";
  import { Button } from "$lib/components/ui/button";

  type State =
    | { kind: "idle" }
    | { kind: "pending" }
    | { kind: "done"; result: PromoteResult }
    | { kind: "error"; message: string };

  let {
    sessionId,
    exchangeId,
  }: {
    sessionId: string;
    exchangeId: string;
  } = $props();

  let state = $state<State>({ kind: "idle" });

  async function promote() {
    state = { kind: "pending" };
    try {
      state = {
        kind: "done",
        result: await promoteExchange(sessionId, exchangeId),
      };
    } catch (error) {
      state = {
        kind: "error",
        message: error instanceof Error ? error.message : "Failed to promote",
      };
    }
  }
</script>

{#if state.kind === "done"}
  <span
    class="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-faint"
  >
    {state.result.mode === "ingested"
      ? state.result.title
        ? `saved as "${state.result.title}"`
        : "saved as source"
      : "submitted for review"}
  </span>
{:else if state.kind === "error"}
  <span
    class="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-destructive"
  >
    {state.message}
  </span>
{:else}
  <Button
    variant="ghost"
    size="sm"
    onclick={() => void promote()}
    disabled={state.kind === "pending"}
    class="h-auto px-2 py-1 font-mono text-[length:var(--text-chrome)] tracking-[0.08em] text-warm-ghost hover:bg-transparent hover:text-warm-faint"
  >
    {state.kind === "pending" ? "saving…" : "save as source"}
  </Button>
{/if}
