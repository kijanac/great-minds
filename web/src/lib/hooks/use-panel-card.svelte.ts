import { goto } from "$app/navigation";
import { createLinkInterceptor } from "$lib/hooks/use-link-interceptor";
import type { SourceDocumentSummary, SourceRef, WikiArticleOverview } from "$lib/types";

export function usePanelCard() {
  let selectedCard = $state<SourceRef | null>(null);

  function openArticle(article: WikiArticleOverview) {
    selectedCard = {
      type: "article",
      label: article.file_path,
      document_id: null,
      title: article.title,
      scope: null,
      path: null,
      thinking: null,
    };
  }

  function openSource(source: SourceDocumentSummary) {
    selectedCard = {
      type: "raw",
      label: source.file_path,
      document_id: source.id,
      title: source.title,
      scope: null,
      path: null,
      thinking: null,
    };
  }

  function openSourceArticle(slug: string, title: string) {
    selectedCard = {
      type: "article",
      label: `wiki/${slug}.md`,
      document_id: null,
      title,
      scope: null,
      path: null,
      thinking: null,
    };
  }

  function openPath(path: string, chunk: number | null = null) {
    selectedCard = {
      type: path.startsWith("wiki/") ? "article" : "raw",
      label: path,
      document_id: null,
      title: null,
      scope: null,
      path: null,
      thinking: null,
      ranges: chunk === null ? undefined : [{ start: chunk, end: chunk }],
      full: chunk === null,
    };
  }

  function maximize() {
    const card = selectedCard;
    if (!card) return;
    const range = card.ranges?.length === 1 ? card.ranges[0] : null;
    const hash = range && range.start === range.end ? `#^p${range.start}` : "";
    void goto(
      card.type === "raw" && card.document_id
        ? `/source/${card.document_id}${hash}`
        : `/doc/${card.label}${hash}`,
    );
  }

  return {
    get selectedCard() {
      return selectedCard;
    },
    close() {
      selectedCard = null;
    },
    maximize,
    onLinkClick: createLinkInterceptor(({ path, chunk }) => openPath(path, chunk)),
    openArticle,
    openPath,
    openSource,
    openSourceArticle,
  };
}
