<script module lang="ts">
  import { browser } from "$app/env";

  const STORAGE_KEY = "onboarding-hint-seen";
  let seen = $state(browser && localStorage.getItem(STORAGE_KEY) === "true");

  export function onboardingHintSeen(): boolean {
    return seen;
  }

  export function dismissOnboardingHint(): void {
    seen = true;
    localStorage.setItem(STORAGE_KEY, "true");
  }
</script>

<script lang="ts">
  import X from "@lucide/svelte/icons/x";
  import type { Snippet } from "svelte";

  import { Badge } from "#lib/components/ui/badge/index.ts";
  import { Button } from "#lib/components/ui/button/index.ts";

  let { children }: { children: Snippet } = $props();
</script>

<div
  class="shrink-0 animate-[slide-up_0.28s_ease] border-t border-ink-subtle pt-3 pr-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] pl-[var(--shell-utility-inset)] md:pr-10"
>
  <div class="mx-auto flex max-w-[740px] items-center justify-between gap-2">
    <p class="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-faint">
      <Badge
        variant="outline"
        class="mr-2 border-gold-dim font-mono text-[length:var(--text-chrome)] tracking-[0.08em] text-gold-muted"
      >
        tip
      </Badge>
      {@render children()}
    </p>
    <Button
      variant="ghost"
      size="icon-sm"
      onclick={dismissOnboardingHint}
      aria-label="dismiss tip"
      class="shrink-0 text-warm-ghost hover:bg-transparent hover:text-warm-faint"
    >
      <X class="size-3.5" />
    </Button>
  </div>
</div>
