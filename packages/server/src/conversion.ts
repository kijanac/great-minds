import { Defuddle } from "defuddle/node";
import { JSDOM } from "jsdom";
import { uploadKind } from "@great-minds/domain";
import { OfficeParser } from "officeparser";

const compactMarkdown = (markdown: string) =>
  markdown
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const nullableString = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? null : trimmed;
};

export type ExtractedArticle = {
  readonly title: string | null;
  readonly markdown: string;
  readonly author: string | null;
  readonly published: string | null;
};

export const htmlToMarkdown = async (html: string, url: string): Promise<ExtractedArticle> => {
  const dom = new JSDOM(html, { url });
  const article = await Defuddle(dom, url, { markdown: true });
  const title = nullableString(article.title);
  return {
    title,
    markdown: compactMarkdown(article.content),
    author: nullableString(article.author),
    published: nullableString(article.published),
  };
};

export const markdownWithTitle = (title: string | null, markdown: string) =>
  title !== null && !markdown.startsWith("# ")
    ? compactMarkdown(`# ${title}\n\n${markdown}`)
    : markdown;

export const stagedFileToMarkdown = async (
  rawBytes: Uint8Array,
  filename: string,
  mimetype: string,
) => {
  const kind = uploadKind(filename, mimetype);
  if (kind === "text") {
    return new TextDecoder("utf-8", { fatal: true }).decode(rawBytes);
  }
  if (kind === "html") {
    const html = new TextDecoder("utf-8", { fatal: true }).decode(rawBytes);
    const converted = await htmlToMarkdown(html, "https://uploaded.local/");
    return markdownWithTitle(converted.title, converted.markdown);
  }
  if (kind === "office") {
    const parsed = await OfficeParser.parseOffice(Buffer.from(rawBytes), {
      newlineDelimiter: "\n",
      ignoreNotes: false,
      allowRemoteAssets: false,
    });
    return (await parsed.to("text")).value;
  }
  throw new Error(`Unsupported staged upload: ${filename}`);
};
