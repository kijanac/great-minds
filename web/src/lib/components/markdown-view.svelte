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
    resolveBlockRefs = false,
    onLinkClick,
  }: {
    source: string;
    variant?: "panel" | "article";
    stripBlockRefs?: boolean;
    resolveBlockRefs?: boolean;
    onLinkClick?: (event: MouseEvent) => void;
  } = $props();

  const BLOCK_REF_RE = /\s*\^p\d+(?=\n|$)/gm;
  const ANCHORED_TAGS = new Set([
    "h1",
    "h2",
    "h3",
    "p",
    "ul",
    "ol",
    "blockquote",
  ]);

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
    const rendered = processor.runSync(parsed) as HastNode;
    if (stripBlockRefs && resolveBlockRefs) {
      assignBlockRefIds(rendered, source);
    }
    return rendered;
  });

  function assignBlockRefIds(root: HastNode, originalSource: string): void {
    const markers: { position: number; chunk: number }[] = [];
    const markerPattern = /\s*\^p(\d+)(?=\n|$)/gm;
    let removed = 0;
    let match: RegExpExecArray | null;

    while ((match = markerPattern.exec(originalSource)) !== null) {
      markers.push({
        position: match.index - removed,
        chunk: Number(match[1]),
      });
      removed += match[0].length;
    }

    const claimed = new Set<number>();
    const walk = (node: HastNode): void => {
      if (
        node.type === "element" &&
        node.tagName &&
        ANCHORED_TAGS.has(node.tagName)
      ) {
        const start = node.position?.start?.offset;
        const end = node.position?.end?.offset;
        if (start != null && end != null) {
          const marker = markers.find(
            (candidate) =>
              !claimed.has(candidate.chunk) &&
              candidate.position >= start &&
              candidate.position <= end + 1,
          );
          if (marker) {
            claimed.add(marker.chunk);
            node.properties = {
              ...node.properties,
              id: `^p${marker.chunk}`,
            };
          }
        }
      }
      node.children?.forEach(walk);
    };
    walk(root);
  }
</script>

<HastNodeView node={tree} {variant} {onLinkClick} />
