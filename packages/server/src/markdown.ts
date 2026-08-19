import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import type { SessionExchangeEvent, SessionOrigin } from "@great-minds/domain";

const PARA_SPLIT_RE = /\n\s*\n/;
const HEADING_LINE_RE = /^(#{1,6})\s+(.+)$/;
const ANCHOR_MARKER_RE = /\s*\^p\d+\s*$/gm;

type BuildDocumentInput = {
  readonly sourceType?: string;
  readonly url?: string | null;
  readonly origin?: string | null;
  readonly sessionId?: string | null;
  readonly exchangeId?: string | null;
  readonly sessionQuery?: string | null;
  readonly sourceDocPath?: string | null;
  readonly sourceAnchor?: string | null;
  readonly sourceParagraphIndex?: number | null;
  readonly anchoredTo?: string | null;
  readonly anchoredSection?: string | null;
  readonly intent?: string | null;
};

type Block = {
  readonly raw: string;
  readonly chunkIndex: number | null;
  readonly heading: string | null;
};

const buildFrontmatter = (known: Record<string, unknown>) => {
  const frontmatter = Object.fromEntries(
    Object.entries(known).filter(([, value]) => value !== null && value !== undefined),
  );
  return `---\n${stringifyYaml(frontmatter)}---\n`;
};

const walkBlocks = (content: string): readonly Block[] => {
  const blocks: Block[] = [];
  let paragraph = 0;
  for (const rawBlock of content.split(PARA_SPLIT_RE)) {
    const raw = rawBlock.replace(ANCHOR_MARKER_RE, "").trim();
    if (raw.length === 0) {
      continue;
    }
    const [firstLine = "", ...rest] = raw.split("\n");
    const heading = HEADING_LINE_RE.exec(firstLine)?.[2]?.trim() ?? null;
    if (heading !== null && rest.join("\n").trim().length === 0) {
      blocks.push({ raw, chunkIndex: null, heading });
      continue;
    }
    blocks.push({ raw, chunkIndex: paragraph, heading });
    paragraph += 1;
  }
  return blocks;
};

const FRONTMATTER_RE = /^---\n(.+?)\n---\n/s;
const WIKI_LINK_RE = /\[([^\]]*)\]\((wiki\/[^)]+\.md)\)/g;

export const parseFrontmatter = (content: string) => {
  const match = FRONTMATTER_RE.exec(content);
  if (match === null) return { frontmatter: {}, body: content } as const;
  const parsed = parseYaml(match[1] ?? "") as unknown;
  return {
    frontmatter:
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {},
    body: content.slice(match[0].length),
  } as const;
};

export const markdownParagraphs = (content: string) => {
  const paragraphs: { index: number; heading: string; body: string }[] = [];
  let heading = "";
  for (const block of walkBlocks(content)) {
    if (block.heading !== null) heading = block.heading;
    if (block.chunkIndex === null) continue;
    paragraphs.push({ index: block.chunkIndex, heading, body: block.raw });
  }
  return paragraphs;
};

export const extractWikiLinkTargets = (content: string) => {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(WIKI_LINK_RE)) {
    const path = match[2];
    if (path !== undefined && !seen.has(path)) {
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
};

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

// Horizontal whitespace only: ANCHOR_MARKER_RE would swallow the newline and
// merge adjacent paragraphs when stripping a whole document.
export const stripAnchors = (content: string) => content.replace(/[ \t]*\^p\d+$/gm, "");

export const injectAnchors = (content: string) => {
  const blocks = walkBlocks(content);
  if (blocks.length === 0) {
    return content;
  }
  return (
    blocks
      .map((block) =>
        block.chunkIndex === null ? block.raw : `${block.raw} ^p${block.chunkIndex}`,
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
    source_paragraph_index: input.sourceParagraphIndex,
    anchored_to: input.anchoredTo,
    anchored_section: input.anchoredSection,
    intent: input.intent,
  };
  return buildFrontmatter(known) + injectAnchors(content);
};

export const sessionExchangePath = (exchangeId: string) => `raw/sessions/${exchangeId}.md`;

export const sessionExchangeDocumentInput = (
  sessionId: string,
  exchange: SessionExchangeEvent,
  sessionOrigin: SessionOrigin | null,
): BuildDocumentInput => ({
  sourceType: "session",
  origin: "session-exchange",
  sessionId,
  exchangeId: exchange.exId,
  sessionQuery: exchange.query,
  sourceDocPath: sessionOrigin?.doc_path ?? null,
  sourceAnchor:
    sessionOrigin?.anchor !== undefined &&
    sessionOrigin.anchor !== null &&
    sessionOrigin.anchor.length > 0
      ? sessionOrigin.anchor
      : null,
  sourceParagraphIndex: sessionOrigin?.paragraph_index ?? null,
});

export const buildSessionExchangeDocument = (
  sessionId: string,
  exchange: SessionExchangeEvent,
  sessionOrigin: SessionOrigin | null,
) => buildDocument(exchange.answer ?? "", sessionExchangeDocumentInput(sessionId, exchange, sessionOrigin));
