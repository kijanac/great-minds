<script lang="ts">
  import * as Popover from "$lib/components/ui/popover";
  import type { HastNode } from "$lib/markdown-plugins";
  import { cn } from "$lib/utils";
  import HastNodeView from "./hast-node.svelte";

  type Variant = "panel" | "article" | "answer" | "btw";

  let {
    node,
    variant,
    onLinkClick,
    blockOffset,
    onBlockMouseUp,
    topLevel = false,
    footnoteMode = "popover",
    activeFootnote = null,
    onFootnoteHover,
  }: {
    node: HastNode;
    variant: Variant;
    onLinkClick?: (event: MouseEvent) => void;
    blockOffset?: number;
    onBlockMouseUp?: (event: MouseEvent, offset: number) => void;
    topLevel?: boolean;
    footnoteMode?: "margin" | "popover";
    activeFootnote?: string | null;
    onFootnoteHover?: (id: string | null) => void;
  } = $props();

  const CLASSES: Record<Variant, Record<string, string>> = {
    panel: {
      h1: "mt-5 mb-2 text-[length:var(--text-heading)] font-bold text-foreground first:mt-0",
      h2: "mt-5 mb-2 text-[length:var(--text-body)] font-bold text-foreground first:mt-0",
      h3: "mt-4 mb-2 font-mono text-[length:var(--text-caption)] tracking-[0.1em] text-gold uppercase",
      p: "mb-[13px] text-[length:var(--text-small)] leading-[1.76] text-warm-faint last:mb-0",
      ul: "mb-[13px] ml-2 list-inside list-disc text-[length:var(--text-small)] leading-[1.76] text-warm-faint",
      ol: "mb-[13px] ml-2 list-inside list-decimal text-[length:var(--text-small)] leading-[1.76] text-warm-faint",
      li: "mb-1",
      blockquote:
        "my-3 border-l-2 border-gold-dim pl-3.5 text-[length:var(--text-small)] leading-[1.76] text-warm-faint italic",
      em: "text-warm",
      strong: "font-bold text-foreground",
      code: "rounded-sm bg-code-bg px-1.5 py-0.5 font-mono text-[length:var(--text-caption)] text-gold",
      pre: "mb-4 overflow-x-auto rounded-sm bg-code-bg p-3",
      table: "mb-4 w-full border-collapse text-[length:var(--text-caption)]",
      th: "border-b border-ink-border px-2 py-1.5 text-left font-mono text-gold-muted",
      td: "border-b border-ink-subtle px-2 py-1.5 text-warm-faint",
    },
    article: {
      h1: "mt-8 mb-4 scroll-mt-20 text-[length:var(--text-heading)] font-bold text-foreground first:mt-0 target:border-l-2 target:border-gold target:bg-gold/10 target:pl-3",
      h2: "mt-8 mb-3 scroll-mt-20 text-[length:var(--text-heading)] font-bold text-foreground first:mt-0 target:border-l-2 target:border-gold target:bg-gold/10 target:pl-3",
      h3: "mt-6 mb-2 scroll-mt-20 font-mono text-[length:var(--text-caption)] font-medium tracking-[0.14em] text-gold uppercase target:border-l-2 target:border-gold target:bg-gold/10 target:pl-3",
      p: "mb-4 scroll-mt-20 text-[length:var(--text-body)] leading-[1.85] text-warm-dim target:border-l-2 target:border-gold target:bg-gold/10 target:pl-3",
      ul: "mb-4 ml-2 list-inside list-disc scroll-mt-20 text-[length:var(--text-body)] leading-[1.85] text-warm-dim target:border-l-2 target:border-gold target:bg-gold/10 target:pl-3",
      ol: "mb-4 ml-2 list-inside list-decimal scroll-mt-20 text-[length:var(--text-body)] leading-[1.85] text-warm-dim target:border-l-2 target:border-gold target:bg-gold/10 target:pl-3",
      li: "mb-1",
      blockquote:
        "my-4 scroll-mt-20 border-l-2 border-gold-dim pl-4 text-[length:var(--text-body)] leading-[1.85] text-warm-faint italic target:border-gold target:bg-gold/10",
      em: "text-warm",
      strong: "font-bold text-foreground",
      code: "rounded-sm bg-code-bg px-1.5 py-0.5 font-mono text-[length:var(--text-small)] text-gold",
      pre: "mb-4 overflow-x-auto rounded-sm bg-code-bg p-4",
      table: "mb-5 w-full border-collapse text-[length:var(--text-small)]",
      th: "border-b border-ink-border px-3 py-2 text-left font-mono text-gold-muted",
      td: "border-b border-ink-subtle px-3 py-2 text-warm-dim",
    },
    answer: {
      h1: "mt-[26px] mb-[11px] text-[length:var(--text-heading)] font-bold text-foreground -tracking-[0.01em] first:mt-0",
      h2: "mt-[26px] mb-[11px] text-[length:var(--text-heading)] font-bold text-foreground -tracking-[0.01em] first:mt-0",
      h3: "mt-[18px] mb-2 font-mono text-[length:var(--text-chrome)] font-medium tracking-[0.14em] text-gold uppercase",
      p: "mb-0.5 text-[length:var(--text-body)] leading-[1.82] text-warm-dim",
      ul: "mb-2 ml-2 list-inside list-disc text-[length:var(--text-body)] leading-[1.82] text-warm-dim",
      ol: "mb-2 ml-2 list-inside list-decimal text-[length:var(--text-body)] leading-[1.82] text-warm-dim",
      li: "mb-1",
      blockquote:
        "my-3 border-l-2 border-gold-dim pl-3.5 text-warm-faint italic",
      em: "text-warm",
      strong: "font-bold text-foreground",
      code: "rounded-sm bg-code-bg px-1.5 py-0.5 font-mono text-[length:var(--text-small)] text-gold",
      pre: "mb-4 overflow-x-auto rounded-sm bg-code-bg p-3",
      table: "mb-4 w-full border-collapse text-[length:var(--text-small)]",
      th: "border-b border-ink-border px-2 py-1.5 text-left font-mono text-gold-muted",
      td: "border-b border-ink-subtle px-2 py-1.5 text-warm-dim",
    },
    btw: {
      h1: "mb-2 text-[length:var(--text-small)] font-bold text-foreground",
      h2: "mb-2 text-[length:var(--text-small)] font-bold text-foreground",
      h3: "mb-1.5 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-gold uppercase",
      p: "mb-2 last:mb-0",
      ul: "mb-1 ml-2 list-inside list-disc",
      ol: "mb-1 ml-2 list-inside list-decimal",
      li: "mb-0.5",
      blockquote:
        "my-1.5 border-l-2 border-gold-dim pl-2.5 text-warm-faint italic",
      em: "text-warm",
      strong: "font-bold text-foreground",
      code: "rounded-sm bg-code-bg px-1 py-0.5 font-mono text-[length:var(--text-chrome)] text-gold",
      pre: "mb-3 overflow-x-auto rounded-sm bg-code-bg p-2.5",
      table: "mb-3 w-full border-collapse text-[length:var(--text-chrome)]",
      th: "border-b border-ink-border px-2 py-1 text-left font-mono text-gold-muted",
      td: "border-b border-ink-subtle px-2 py-1 text-warm-faint",
    },
  };

  function attributeName(name: string): string {
    if (name === "className") return "class";
    if (name === "htmlFor") return "for";
    if (name.startsWith("data") || name.startsWith("aria")) {
      return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    }
    return name;
  }

  function attributes(properties: Record<string, unknown> | undefined) {
    const output: Record<string, string | number | boolean | undefined> = {};
    for (const [name, value] of Object.entries(properties ?? {})) {
      if (name === "className" || value == null) continue;
      const key = attributeName(name);
      if (Array.isArray(value)) output[key] = value.join(" ");
      else if (["string", "number", "boolean"].includes(typeof value)) {
        output[key] = value as string | number | boolean;
      }
    }
    return output;
  }

  function propertyClass(
    properties: Record<string, unknown> | undefined,
  ): string {
    const value = properties?.className;
    return Array.isArray(value)
      ? value.join(" ")
      : typeof value === "string"
        ? value
        : "";
  }

  const attrs = $derived(attributes(node.properties));
  const popoverAttrs = $derived.by(() => {
    const { id: _id, ...rest } = attrs;
    return rest;
  });
  const tag = $derived(node.tagName ?? "span");
  const className = $derived(
    cn(CLASSES[variant][tag], propertyClass(node.properties)),
  );
  const footnote = $derived(
    typeof node.properties?.dataFootnoteContent === "string"
      ? node.properties.dataFootnoteContent
      : null,
  );
  const footnoteId = $derived(
    typeof node.properties?.dataMarginNoteId === "string"
      ? node.properties.dataMarginNoteId
      : null,
  );
  const href = $derived(
    typeof node.properties?.href === "string"
      ? node.properties.href
      : undefined,
  );
  const elementId = $derived(
    typeof node.properties?.id === "string" ? node.properties.id : null,
  );
  const external = $derived(href?.startsWith("http") ?? false);
</script>

{#if node.type === "root"}
  {#each node.children ?? [] as child, index (`${index}-${child.position?.start?.offset ?? ""}`)}
    <HastNodeView
      node={child}
      {variant}
      {onLinkClick}
      topLevel
      {footnoteMode}
      {activeFootnote}
      {onFootnoteHover}
    />
  {/each}
{:else if node.type === "text"}
  {node.value ?? ""}
{:else if node.type === "element" && tag === "a"}
  {#if footnote && footnoteMode === "popover"}
    {#if elementId}
      <span id={elementId} class="sr-only" aria-hidden="true"></span>
    {/if}
    <Popover.Root>
      <Popover.Trigger>
        {#snippet child({ props })}
          <a
            {...popoverAttrs}
            {...props}
            {href}
            onclick={(event) => {
              event.preventDefault();
              (props.onclick as ((event: MouseEvent) => void) | undefined)?.(
                event,
              );
            }}
            class={cn(
              "text-gold underline decoration-gold/30 underline-offset-2 transition-colors hover:decoration-gold/60",
              className,
            )}
          >
            {#each node.children ?? [] as child, index (`${index}-${child.position?.start?.offset ?? ""}`)}
              <HastNodeView
                node={child}
                {variant}
                {onLinkClick}
                {footnoteMode}
                {activeFootnote}
                {onFootnoteHover}
              />
            {/each}
          </a>
        {/snippet}
      </Popover.Trigger>
      <Popover.Content
        side="top"
        class="w-[min(22rem,calc(100vw-2rem))] border border-gold-dim bg-popover p-3 text-left font-serif text-[length:var(--text-caption)] leading-[1.65] text-warm-faint shadow-[0_8px_28px_rgba(0,0,0,0.35)]"
        >{footnote}</Popover.Content
      >
    </Popover.Root>
  {:else}
    <a
      {...attrs}
      {href}
      target={external ? "_blank" : undefined}
      rel={external ? "noopener noreferrer" : undefined}
      onclick={onLinkClick}
      onmouseenter={() => footnoteId && onFootnoteHover?.(footnoteId)}
      onmouseleave={() => footnoteId && onFootnoteHover?.(null)}
      class={cn(
        "text-gold underline decoration-gold/30 underline-offset-2 transition-colors hover:decoration-gold/60",
        footnoteId &&
          activeFootnote === footnoteId &&
          "text-warm-dim decoration-gold/60",
        className,
      )}
    >
      {#each node.children ?? [] as child, index (`${index}-${child.position?.start?.offset ?? ""}`)}
        <HastNodeView
          node={child}
          {variant}
          {onLinkClick}
          {footnoteMode}
          {activeFootnote}
          {onFootnoteHover}
        />
      {/each}
    </a>
  {/if}
{:else if node.type === "element"}
  <svelte:element
    this={tag}
    {...attrs}
    data-block-offset={blockOffset}
    data-footnote-block={topLevel ? "" : undefined}
    class={className || undefined}
    onmouseup={(event) => {
      if (blockOffset != null) onBlockMouseUp?.(event, blockOffset);
    }}
  >
    {#each node.children ?? [] as child, index (`${index}-${child.position?.start?.offset ?? ""}`)}
      <HastNodeView
        node={child}
        {variant}
        {onLinkClick}
        {footnoteMode}
        {activeFootnote}
        {onFootnoteHover}
      />
    {/each}
  </svelte:element>
{/if}
