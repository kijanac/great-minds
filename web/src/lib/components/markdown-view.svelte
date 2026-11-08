<script lang="ts">
  import { assignBlockRefIds, stripBlockRefMarkers } from "#lib/block-refs.ts";
  import FootnoteNotes from "#lib/components/footnote-notes.svelte";
  import HastNodeView from "#lib/components/hast-node.svelte";
  import { parseMarkdown } from "#lib/markdown.ts";

  let {
    source,
    variant = "article",
    stripBlockRefs = false,
    resolveBlockRefs = false,
    onLinkClick,
    marginFootnotes = false,
    panelDocked = false,
  }: {
    source: string;
    variant?: "panel" | "article" | "answer" | "btw";
    stripBlockRefs?: boolean;
    resolveBlockRefs?: boolean;
    onLinkClick?: (event: MouseEvent) => void;
    marginFootnotes?: boolean;
    panelDocked?: boolean;
  } = $props();

  const displaySource = $derived(
    stripBlockRefs ? stripBlockRefMarkers(source) : source,
  );
  const tree = $derived.by(() => {
    const rendered = parseMarkdown(displaySource);
    if (stripBlockRefs && resolveBlockRefs) {
      assignBlockRefIds(rendered, source);
    }
    return rendered;
  });
  const footnoteRoots = $derived([tree]);
</script>

<FootnoteNotes
  roots={footnoteRoots}
  idPrefix="fn-margin"
  {marginFootnotes}
  {panelDocked}
  resetKey={displaySource}
  {onLinkClick}
>
  {#snippet children({
    footnoteMode,
    footnoteDefinitions,
    activeFootnote,
    pinnedFootnotes,
    onFootnoteHover,
    onFootnoteToggle,
  })}
    <HastNodeView
      node={tree}
      {variant}
      {onLinkClick}
      {footnoteMode}
      {footnoteDefinitions}
      {activeFootnote}
      {pinnedFootnotes}
      {onFootnoteHover}
      {onFootnoteToggle}
    />
  {/snippet}
</FootnoteNotes>
