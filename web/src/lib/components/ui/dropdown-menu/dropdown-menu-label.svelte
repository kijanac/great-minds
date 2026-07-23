<script lang="ts">
  import { cn } from "$lib/utils.js";
  import type { WithElementRef } from "$lib/components/ui/types.js";
  import type { HTMLAttributes } from "svelte/elements";

  let {
    ref = $bindable(null),
    class: className,
    inset,
    children,
    ...restProps
  }: WithElementRef<HTMLAttributes<HTMLDivElement>> & {
    inset?: boolean;
  } = $props();
</script>

<div
  bind:this={ref}
  data-slot="dropdown-menu-label"
  data-inset={inset}
  class={cn(
    "px-1.5 py-1 text-xs font-medium text-muted-foreground data-inset:pl-7",
    "data-[inset]:pl-7",
    className,
  )}
  {...restProps}
>
  {@render children?.()}
</div>
