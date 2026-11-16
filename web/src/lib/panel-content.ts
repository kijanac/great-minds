import {
  fetchChunks,
  fetchLinks,
  readDocument,
  readPersonalDocument,
  readSourceDocument,
  type DocumentScope,
  type DocChunk,
  type LinkedArticles,
} from "#lib/api/doc.ts";
import type { SourceRef } from "#lib/types.ts";

export type PanelContent =
  | { mode: "doc"; body: string }
  | { mode: "chunks"; chunks: readonly DocChunk[] }
  | { mode: "outline" }
  | { mode: "links"; links: LinkedArticles };

export async function loadPanelContent(
  card: SourceRef,
  scope: DocumentScope,
  signal?: AbortSignal,
): Promise<PanelContent> {
  if (scope === "personal") {
    const document = await readPersonalDocument(card.label, signal);
    return { mode: "doc", body: document.body };
  }
  if (card.type === "links") {
    return { mode: "links", links: await fetchLinks(card.label, signal) };
  }

  const source =
    card.type === "raw" && card.document_id !== null
      ? await readSourceDocument(card.document_id, signal)
      : null;
  const path = source?.article.file_path ?? card.label;

  if (card.ranges?.length && !card.full) {
    const groups = await Promise.all(
      card.ranges.map((range) => fetchChunks(path, range.start, range.end, signal)),
    );
    const chunks = new Map(groups.flat().map((chunk) => [chunk.chunk_index, chunk]));
    return {
      mode: "chunks",
      chunks: [...chunks.values()].sort((a, b) => a.chunk_index - b.chunk_index),
    };
  }
  if (card.outline === true && !card.full) return { mode: "outline" };

  const document = source ?? (await readDocument(path, signal));
  return { mode: "doc", body: document.body };
}
