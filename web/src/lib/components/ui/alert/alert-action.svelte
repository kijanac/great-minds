<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";

  import { cn } from "$lib/utils";

  let {
    class: className,
    children,
    ...restProps
  }: HTMLAttributes<HTMLDivElement> = $props();
</script>

<div
  data-slot="alert-action"
  class={cn("absolute top-2 right-2", className)}
  {...restProps}
>
  {@render children?.()}
</div>
