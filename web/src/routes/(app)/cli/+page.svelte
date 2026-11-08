<script lang="ts">
  import { page } from "$app/state";
  import { domainErrorDetail } from "@great-minds/client";
  import type { CliLoginRequest } from "@great-minds/domain";

  import { api, run } from "#lib/api/app.ts";

  type View =
    | { kind: "enter" }
    | { kind: "loading" }
    | { kind: "confirm"; request: CliLoginRequest }
    | { kind: "approved" }
    | { kind: "cancelled" }
    | { kind: "error"; message: string };

  const LENGTH = 8;
  const normalize = (value: string) =>
    value
      .toUpperCase()
      .replace(/[^A-Z]/g, "")
      .slice(0, LENGTH);

  let view = $state<View>({ kind: "enter" });
  let code = $state("");
  let caret = $state(0);
  let focused = $state(false);
  let busy = $state(false);
  let input = $state<HTMLInputElement | null>(null);

  const failure = (reason: unknown) =>
    domainErrorDetail(reason) ?? "Something went wrong. Try again.";

  async function lookUp(userCode: string) {
    view = { kind: "loading" };
    try {
      const request = await run(
        api.auth.getCliLogin({ query: { user_code: userCode } }),
      );
      view = { kind: "confirm", request };
    } catch (reason) {
      view = { kind: "error", message: failure(reason) };
    }
  }

  async function decide(approve: boolean) {
    if (view.kind !== "confirm" || busy) return;
    busy = true;
    const payload = { user_code: view.request.user_code };
    try {
      await run(
        approve
          ? api.auth.approveCliLogin({ payload })
          : api.auth.denyCliLogin({ payload }),
      );
      view = { kind: approve ? "approved" : "cancelled" };
    } catch (reason) {
      view = { kind: "error", message: failure(reason) };
    } finally {
      busy = false;
    }
  }

  $effect(() => {
    const fromLink = normalize(page.url.searchParams.get("code") ?? "");
    if (fromLink.length === LENGTH) void lookUp(fromLink);
  });

  function select(index: number) {
    if (!input) return;
    const at = Math.max(0, Math.min(index, code.length));
    input.setSelectionRange(at, at < code.length ? at + 1 : at);
    caret = at;
  }

  function onInput() {
    if (!input) return;
    const before = normalize(
      input.value.slice(0, input.selectionStart ?? 0),
    ).length;
    code = normalize(input.value);
    input.value = code;
    select(Math.min(before, LENGTH));
  }

  function onKeydown(event: KeyboardEvent) {
    if (!input) return;
    const at = input.selectionStart ?? 0;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      select(at - 1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      select(at + 1);
    } else if (
      event.key === "Backspace" &&
      input.selectionStart === input.selectionEnd &&
      at > 0
    ) {
      event.preventDefault();
      code = code.slice(0, at - 1) + code.slice(at);
      input.value = code;
      select(at - 1);
    } else if (event.key === "Enter" && code.length === LENGTH) {
      void lookUp(code);
    }
  }

  const slotClass =
    "flex h-12 w-9 items-center justify-center rounded-sm border bg-ink-raised font-mono text-[22px] text-warm";
</script>

<svelte:head>
  <title>Sign in | Great Minds</title>
</svelte:head>

<div class="flex h-dvh items-center justify-center bg-ink">
  <div class="w-full max-w-sm space-y-6 px-6">
    {#if view.kind === "enter"}
      <h1 class="font-serif text-title text-warm">Sign in</h1>
      <p class="text-small text-warm-faint">
        Enter the code shown in your terminal.
      </p>
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions - the hidden input handles keys -->
      <div
        class="relative flex items-center justify-center gap-1.5"
        onmousedown={(event) => {
          event.preventDefault();
          input?.focus();
        }}
      >
        <input
          bind:this={input}
          value={code}
          oninput={onInput}
          onkeydown={onKeydown}
          onfocus={() => (focused = true)}
          onblur={() => (focused = false)}
          onselect={() => (caret = input?.selectionStart ?? 0)}
          autocomplete="one-time-code"
          autocapitalize="characters"
          spellcheck="false"
          aria-label="Code from your terminal"
          class="pointer-events-none absolute inset-0 opacity-0"
        />
        {#each Array.from({ length: LENGTH }, (_, index) => index) as index (index)}
          {#if index === 4}
            <span class="px-0.5 font-mono text-warm-ghost">–</span>
          {/if}
          <button
            type="button"
            tabindex="-1"
            aria-hidden="true"
            onmousedown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              input?.focus();
              select(index);
            }}
            class={`${slotClass} ${focused && index === Math.min(caret, LENGTH - 1) ? "border-gold ring-1 ring-gold" : "border-ink-border"}`}
          >
            {code[index] ?? ""}
          </button>
        {/each}
      </div>
      <button
        type="button"
        disabled={code.length < LENGTH}
        onclick={() => void lookUp(code)}
        class="w-full rounded-sm bg-gold px-4 py-3 font-mono text-small font-semibold text-primary-foreground transition-colors hover:bg-gold-hover disabled:opacity-50"
      >
        Continue
      </button>
    {:else if view.kind === "loading"}
      <p class="text-center font-mono text-small text-warm-ghost">…</p>
    {:else if view.kind === "confirm"}
      <h1 class="font-serif text-title text-warm">Sign in</h1>
      <p class="text-small text-warm-faint">
        Check that this code matches the one in your terminal.
      </p>
      <div
        class="rounded-sm border border-gold-dim py-3 text-center font-mono text-[26px] tracking-[0.18em] text-warm"
      >
        {view.request.user_code}
      </div>
      <dl class="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5 text-small">
        <dt class="font-mono text-caption text-warm-ghost">Signed in as</dt>
        <dd class="text-warm-dim">{view.request.email}</dd>
        <dt class="font-mono text-caption text-warm-ghost">Computer</dt>
        <dd class="text-warm-dim">{view.request.computer}</dd>
        <dt class="font-mono text-caption text-warm-ghost">Access</dt>
        <dd class="text-warm-dim">Everything your account can do</dd>
      </dl>
      <div class="flex items-center gap-4">
        <button
          type="button"
          disabled={busy}
          onclick={() => void decide(true)}
          class="rounded-sm bg-gold px-4 py-2 font-mono text-small font-semibold text-primary-foreground transition-colors hover:bg-gold-hover disabled:opacity-50"
        >
          Approve
        </button>
        <button
          type="button"
          disabled={busy}
          onclick={() => void decide(false)}
          class="font-mono text-small text-warm-faint transition-colors hover:text-warm disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    {:else if view.kind === "approved"}
      <h1 class="font-serif text-title text-gold-muted">Signed in.</h1>
      <p class="text-small text-warm-faint">
        You can close this tab and return to your terminal.
      </p>
    {:else if view.kind === "cancelled"}
      <h1 class="font-serif text-title text-warm">Sign-in cancelled.</h1>
    {:else}
      <h1 class="font-serif text-title text-warm">Sign in</h1>
      <p role="alert" class="text-small text-red-400/90">{view.message}</p>
      <button
        type="button"
        onclick={() => {
          code = "";
          view = { kind: "enter" };
        }}
        class="font-mono text-small text-warm-faint transition-colors hover:text-warm"
      >
        Enter a code
      </button>
    {/if}
  </div>
</div>
