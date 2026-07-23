<script lang="ts">
  import type { Article } from "$lib/api/doc";
  import DocHeader from "$lib/components/doc-header.svelte";
  import MarkdownView from "$lib/components/markdown-view.svelte";

  let {
    document,
    body,
    archived = false,
    supersededBy = null,
    onSupersessorClick,
    onLinkClick,
  }: {
    document: Article;
    body: string;
    archived?: boolean;
    supersededBy?: string | null;
    onSupersessorClick?: (slug: string) => void;
    onLinkClick?: (event: MouseEvent) => void;
  } = $props();
</script>

<article
  class="mx-auto max-w-[740px] px-4 pt-6 pb-20 select-text md:px-10 md:pt-10"
>
  <DocHeader {document} {archived} {supersededBy} {onSupersessorClick} />
  <MarkdownView
    source={body}
    variant="article"
    stripBlockRefs
    resolveBlockRefs
    {onLinkClick}
  />
</article>
