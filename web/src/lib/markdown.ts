import { withoutHtmlBlocks } from "@great-minds/domain";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

import { rehypeFootnoteSeparators, remarkPlugins, type HastNode } from "#lib/markdown-plugins.ts";

const processor = unified()
  .use(remarkParse)
  .use(remarkPlugins)
  .use(withoutHtmlBlocks)
  .use(remarkRehype)
  .use(rehypeFootnoteSeparators);

export function parseMarkdown(source: string): HastNode {
  return processor.runSync(processor.parse(source)) as HastNode;
}
