import type { SourceDocumentSummary, SourceRef, WikiArticleOverview } from "$lib/types";

export function usePanelCard() {
  let selectedCard = $state<SourceRef | null>(null);

  function openArticle(article: WikiArticleOverview) {
    selectedCard = {
      type: "article",
      label: article.file_path,
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
