<script lang="ts" module>
  import { cva, type VariantProps } from "class-variance-authority";

  export const alertVariants = cva(
    "group/alert relative grid w-full gap-0.5 rounded-lg border px-2.5 py-2 text-left text-sm has-data-[slot=alert-action]:relative has-data-[slot=alert-action]:pr-18 has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-2 *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg]:text-current *:[svg:not([class*='size-'])]:size-4",
    {
      variants: {
        variant: {
          default: "bg-card text-card-foreground",
          destructive:
            "bg-card text-destructive *:data-[slot=alert-description]:text-destructive/90 *:[svg]:text-current",
        },
      },
      defaultVariants: {
        variant: "default",
      },
    },
  );

  export type AlertVariant = VariantProps<typeof alertVariants>["variant"];
</script>

<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";

  import { cn } from "$lib/utils";

  let {
    class: className,
    variant = "default",
    children,
    ...restProps
  }: HTMLAttributes<HTMLDivElement> & { variant?: AlertVariant } = $props();
</script>

<div
  data-slot="alert"
  role="alert"
  class={cn(alertVariants({ variant }), className)}
  {...restProps}
>
  {@render children?.()}
</div>
