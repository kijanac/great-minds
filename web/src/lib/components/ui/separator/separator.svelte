<script lang="ts">
  import { Separator as SeparatorPrimitive } from "bits-ui";
  import { cn } from "$lib/utils.js";

  let {
    ref = $bindable(null),
    class: className,
    "data-slot": dataSlot = "separator",
    orientation = "horizontal",
    ...restProps
  }: SeparatorPrimitive.RootProps = $props();
</script>

<SeparatorPrimitive.Root
  bind:ref
  data-slot={dataSlot}
  {orientation}
  class={cn(
    "shrink-0 bg-border data-horizontal:h-px data-horizontal:w-full data-vertical:w-px data-vertical:self-stretch",
    "data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:w-px data-[orientation=vertical]:self-stretch",
    className,
  )}
  {...restProps}
/>
