import { Option, Schema } from "effect";
import type { RootContent } from "mdast";
import { toString } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  passageId,
  stripPassageMarkers,
  type SessionExchange,
  type SessionId,
  type SessionOrigin,
  type Uuid,
} from "@great-minds/domain";

const blockParser = unified().use(remarkParse).use(remarkGfm);

type BuildDocumentInput = {
  readonly sourceType?: string;
  readonly url?: string | null;
  readonly origin?: string | null;
  readonly sessionId?: string | null;
  readonly exchangeId?: string | null;
  readonly sessionQuery?: string | null;
  readonly sourceDocPath?: string | null;
  readonly sourceAnchor?: string | null;
  readonly anchoredTo?: string | null;
  readonly anchoredSection?: string | null;
};

type Block = {
  readonly raw: string;
  readonly chunkIndex: number | null;
  readonly heading: string | null;
  readonly endsInText: boolean;
};

const buildFrontmatter = (known: Record<string, unknown>) => {
  const frontmatter = Object.fromEntries(
    Object.entries(known).filter(([, value]) => value !== null && value !== undefined),
  );
  return `---\n${stringifyYaml(frontmatter)}---\n`;
};

const endsInText = (node: RootContent | undefined): boolean =>
  node?.type === "paragraph" ||
  ((node?.type === "blockquote" || node?.type === "list" || node?.type === "listItem") &&
    endsInText(node.children.at(-1)));

const walkBlocks = (content: string): readonly Block[] => {
  const source = stripPassageMarkers(content);
  const blocks: Block[] = [];
  let paragraph = 0;
  for (const node of blockParser.parse(source).children) {
    for (const part of node.type === "list" && node.spread ? node.children : [node]) {
      if (part.position === undefined) continue;
      const { start, end } = part.position;
      const raw = source.slice((start.offset ?? 0) - start.column + 1, end.offset).trimEnd();
      if (part.type === "heading") {
        blocks.push({ raw, chunkIndex: null, heading: toString(part), endsInText: false });
        continue;
      }
      blocks.push({ raw, chunkIndex: paragraph, heading: null, endsInText: endsInText(part) });
      paragraph += 1;
    }
  }
  return blocks;
};

const FRONTMATTER_RE = /^---\n(.+?)\n---\n/s;

const decodeFrontmatterRecord = Schema.decodeUnknownOption(
  Schema.Record(Schema.String, Schema.Unknown),
);

export const parseFrontmatter = (
  content: string,
): {
  readonly frontmatter: Record<string, unknown>;
  readonly body: string;
} => {
  const match = FRONTMATTER_RE.exec(content);
  if (match === null) return { frontmatter: {}, body: content } as const;
  return {
    frontmatter: Option.getOrElse(decodeFrontmatterRecord(parseYaml(match[1] ?? "")), () => ({})),
    body: content.slice(match[0].length),
  } as const;
};

export const markdownParagraphs = (content: string) => {
  const paragraphs: { index: number; heading: string; body: string }[] = [];
  let heading = "";
  for (const block of walkBlocks(content)) {
    if (block.heading !== null) heading = block.heading;
    if (block.chunkIndex === null) continue;
    paragraphs.push({ index: block.chunkIndex, heading, body: block.raw.trimStart() });
  }
  return paragraphs;
};

const FOOTNOTE_DEFINITION_RE = /^\[\^([^\]\s]+)\]:[ \t]?(.*)$/;

export const footnoteDefinitions = (content: string): ReadonlyMap<string, string> =>
  new Map(
    content.split("\n").flatMap((line) => {
      const match = FOOTNOTE_DEFINITION_RE.exec(line);
      return match === null ? [] : [[match[1] ?? "", (match[2] ?? "").trim()] as const];
    }),
  );

export const withoutFootnoteDefinitions = (body: string) =>
  body
    .split("\n")
    .filter((line) => !FOOTNOTE_DEFINITION_RE.test(line))
    .join("\n")
    .replace(/(\n\s*---\s*)+\s*$/, "\n");

export const footnoteNotes = (text: string, definitions: ReadonlyMap<string, string>) =>
  [...new Set([...text.matchAll(/\[\^([^\]\s]+)\](?!:)/g)].map((match) => match[1] ?? ""))]
    .flatMap((label) => {
      const definition = definitions.get(label);
      return definition === undefined ? [] : [`[^${label}]: ${definition}`];
    })
    .join("\n");

const OPENING_LIMIT = 240;

const plainProse = (markdown: string) =>
  markdown
    .replace(/\[\^\d+\]/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|\*|_)(\S[^*_]*?)\1/g, "$2")
    .replace(/\s+/g, " ")
    .trim();

export const openingSentence = (body: string) => {
  const prose = body
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .find((block) => block !== "" && !/^(#|\[\^|---|>|[-*] |\d+\. |\|)/.test(block));
  if (prose === undefined) return "";
  const text = plainProse(prose);
  for (const match of text.matchAll(/[.!?](?=\s+["“(A-Z])/g)) {
    const end = match.index + 1;
    if (/(^|\s)([A-Z]|St|Mr|Mrs|Dr|Jr|Sr|No|Vol|vs|cf)$/.test(text.slice(0, end - 1))) continue;
    if (end >= 40) return end <= OPENING_LIMIT ? text.slice(0, end) : shortened(text);
  }
  return text.length <= OPENING_LIMIT ? text : shortened(text);
};

const shortened = (text: string) =>
  `${text
    .slice(0, OPENING_LIMIT)
    .replace(/\s+\S*$/, "")
    .replace(/[,;:—–-]$/, "")}…`;

const stringifyRuamelFrontmatter = (frontmatter: Record<string, unknown>) => {
  const yaml = stringifyYaml(frontmatter, {
    defaultKeyType: "PLAIN",
    defaultStringType: "PLAIN",
    indent: 2,
    indentSeq: false,
    lineWidth: 80,
    singleQuote: true,
  });
  const lines = yaml.split("\n");

  // ruamel keeps the wrapping space when it fits inside its 80-column width.
  // eemeli folds at the same word but drops that byte.
  return lines
    .map((line, index) =>
      lines[index + 1]?.startsWith("  ") === true && line.length < 80 ? `${line} ` : line,
    )
    .join("\n");
};

export const serializeFrontmatter = (frontmatter: Record<string, unknown>, body: string) =>
  `---\n${stringifyRuamelFrontmatter(frontmatter)}---\n${body}`;

export const injectAnchors = (content: string) => {
  const blocks = walkBlocks(content);
  if (blocks.length === 0) {
    return content;
  }
  return (
    blocks
      .map((block) =>
        block.chunkIndex === null
          ? block.raw
          : `${block.raw}${block.endsInText ? " " : "\n\n"}${passageId(block.chunkIndex)}`,
      )
      .join("\n\n") + "\n"
  );
};

export const buildDocument = (content: string, input: BuildDocumentInput = {}) => {
  const known = {
    source_type: input.sourceType ?? "document",
    url: input.url,
    origin: input.origin,
    session_id: input.sessionId,
    exchange_id: input.exchangeId,
    session_query: input.sessionQuery,
    source_doc_path: input.sourceDocPath,
    source_anchor: input.sourceAnchor,
    anchored_to: input.anchoredTo,
    anchored_section: input.anchoredSection,
  };
  return buildFrontmatter(known) + injectAnchors(content);
};

export const sessionExchangePath = (exchangeId: Uuid, sourceId: Uuid) =>
  `raw/sessions/${exchangeId}-${sourceId}.md`;

export const sessionExchangeDocumentInput = (
  sessionId: SessionId,
  exchange: SessionExchange,
  sessionOrigin: SessionOrigin | null,
): BuildDocumentInput => ({
  sourceType: "session",
  origin: "session-exchange",
  sessionId,
  exchangeId: exchange.exchange_id,
  sessionQuery: exchange.query,
  sourceDocPath: sessionOrigin?.kind === "document" ? sessionOrigin.doc_path : null,
  sourceAnchor: sessionOrigin?.passage?.quote ?? null,
});

export const buildSessionExchangeDocument = (
  sessionId: SessionId,
  exchange: SessionExchange,
  sessionOrigin: SessionOrigin | null,
) =>
  buildDocument(exchange.answer, sessionExchangeDocumentInput(sessionId, exchange, sessionOrigin));
