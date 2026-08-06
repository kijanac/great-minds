import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { parseOfficeAsync } from "officeparser";
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
  const parsedTitle = article?.title?.trim();
  const title = parsedTitle === undefined || parsedTitle.length === 0 ? null : parsedTitle;
  const content = article?.content ?? dom.window.document.body?.innerHTML ?? html;
  return {
    title,
    markdown: compactMarkdown(turndown.turndown(content)),
  };
};

export const markdownWithTitle = (title: string | null, markdown: string) =>
  title !== null && !markdown.startsWith("# ")
    ? compactMarkdown(`# ${title}\n\n${markdown}`)
    : markdown;

const TEXT_EXTENSIONS = new Set([".md", ".txt", ".text", ".markdown", ".csv", ".json", ".xml"]);
const HTML_EXTENSIONS = new Set([".html", ".htm"]);
const BINARY_EXTENSIONS = new Set([".docx", ".pptx", ".xlsx", ".odt", ".odp", ".ods", ".pdf"]);

export const stagedFileToMarkdown = async (
  rawBytes: Uint8Array,
  filename: string,
  mimetype: string,
) => {
  const suffixAt = filename.lastIndexOf(".");
  const extension = suffixAt < 0 ? ".txt" : filename.slice(suffixAt).toLowerCase();
  if (TEXT_EXTENSIONS.has(extension)) {
    return new TextDecoder("utf-8", { fatal: true }).decode(rawBytes);
  }
  if (HTML_EXTENSIONS.has(extension) || mimetype.toLowerCase().includes("text/html")) {
    const html = new TextDecoder("utf-8", { fatal: true }).decode(rawBytes);
    const converted = htmlToMarkdown(html, "https://uploaded.local/");
    return markdownWithTitle(converted.title, converted.markdown);
  }
  if (BINARY_EXTENSIONS.has(extension)) {
    return parseOfficeAsync(Buffer.from(rawBytes), {
      newlineDelimiter: "\n",
      ignoreNotes: false,
      putNotesAtLast: false,
      outputErrorToConsole: false,
    });
  }
  throw new Error(`Unsupported staged upload conversion extension: ${extension}`);
};
