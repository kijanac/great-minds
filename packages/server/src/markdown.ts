import { stringify as stringifyYaml } from "yaml";

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
