import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

import {
  rehypeFootnoteContent,
  rehypeFootnoteSeparators,
  remarkPlugins,
  type HastNode,
} from "$lib/markdown-plugins";

const processor = unified()
  .use(remarkParse)
  .use(remarkPlugins)
  .use(remarkRehype)
  .use(rehypeFootnoteSeparators)
  .use(rehypeFootnoteContent);

export function parseMarkdown(source: string): HastNode {
  return processor.runSync(processor.parse(source)) as HastNode;
}
