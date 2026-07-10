import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

const compactMarkdown = (markdown: string) =>
  markdown
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

export const htmlToMarkdown = (html: string, url: string) => {
  const dom = new JSDOM(html, { url });
  const article = new Readability(dom.window.document).parse();
  const title = article?.title?.trim();
  const content = article?.content ?? dom.window.document.body?.innerHTML ?? html;
  const body = compactMarkdown(turndown.turndown(content));
  if (title !== undefined && title.length > 0 && !body.startsWith("# ")) {
    return compactMarkdown(`# ${title}\n\n${body}`);
  }
  return body;
};
