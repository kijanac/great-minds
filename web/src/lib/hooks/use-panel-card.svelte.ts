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

  function openPath(path: string) {
    selectedCard = {
      type: path.startsWith("wiki/") ? "article" : "raw",
      label: path,
      document_id: null,
      title: null,
      scope: null,
      path: null,
      thinking: null,
    };
  }

  return {
    get selectedCard() {
      return selectedCard;
    },
    close() {
      selectedCard = null;
    },
    openArticle,
    openPath,
    openSource,
    openSourceArticle,
  };
}
