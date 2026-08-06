import {
  fetchChunks,
  fetchLinks,
  readDocument,
  readPersonalDocument,
  type DocumentScope,
  type DocChunk,
  type LinkedArticles,
} from "$lib/api/doc";
import type { SourceRef } from "$lib/types";

export type PanelContent =
  | { mode: "doc"; body: string }
  | { mode: "chunks"; chunks: DocChunk[] }
  | { mode: "links"; links: LinkedArticles };

export async function loadPanelContent(
  card: SourceRef,
  scope: DocumentScope,
  signal?: AbortSignal,
): Promise<PanelContent | null> {
  if (scope === "personal") {
    const document = await readPersonalDocument(card.label, signal);
    return { mode: "doc", body: document.body };
  }
  if (card.type === "links") {
    return { mode: "links", links: await fetchLinks(card.label, signal) };
  }

  if (card.ranges?.length && !card.full) {
    const groups = await Promise.all(
      card.ranges.map((range) => fetchChunks(card.label, range.start, range.end, signal)),
    );
    return { mode: "chunks", chunks: groups.flat() };
  }

  const document = await readDocument(card.label, signal);
  return { mode: "doc", body: document.body };
}
