<script lang="ts">
  import remarkParse from "remark-parse";
  import remarkRehype from "remark-rehype";
  import { unified } from "unified";

  import HastNodeView from "$lib/components/hast-node.svelte";
  import {
    rehypeFootnoteContent,
    rehypeFootnoteSeparators,
    remarkPlugins,
    type HastNode,
  } from "$lib/markdown-plugins";

  let {
    source,
    variant = "article",
    stripBlockRefs = false,
  }: {
    source: string;
    variant?: "panel" | "article";
    stripBlockRefs?: boolean;
  } = $props();

  const BLOCK_REF_RE = /\s*\^p\d+(?=\n|$)/gm;

  const processor = unified()
    .use(remarkParse)
    .use(remarkPlugins)
    .use(remarkRehype)
    .use(rehypeFootnoteSeparators)
    .use(rehypeFootnoteContent);

  const displaySource = $derived(
    stripBlockRefs ? source.replace(BLOCK_REF_RE, "") : source,
  );
  const tree = $derived.by(() => {
    const parsed = processor.parse(displaySource);
    return processor.runSync(parsed) as HastNode;
  });
</script>

<HastNodeView node={tree} {variant} />
