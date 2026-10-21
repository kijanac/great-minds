<script module lang="ts">
  import { browser } from "$app/environment";

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
  import type { Snippet } from "svelte";

  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";

  let { children }: { children: Snippet } = $props();
</script>

<div
  class="shrink-0 animate-[slide-up_0.28s_ease] border-t border-ink-subtle px-4 py-3 md:px-10"
>
  <div class="mx-auto flex max-w-[740px] items-center justify-between gap-4">
    <p
      class="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-faint"
    >
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
      size="sm"
      onclick={dismissOnboardingHint}
      class="h-auto shrink-0 px-2 py-1 font-mono text-[length:var(--text-chrome)] tracking-[0.08em] text-warm-ghost hover:bg-transparent hover:text-warm-faint"
    >
      dismiss
    </Button>
  </div>
</div>
