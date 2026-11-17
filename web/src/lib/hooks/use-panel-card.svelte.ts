import { goto } from "$app/navigation";
import type { DocumentScope } from "#lib/api/doc.ts";
import { createLinkInterceptor } from "#lib/hooks/use-link-interceptor.ts";
import type { ReadingTrail } from "#lib/research-steps.ts";
import type { SourceDocumentSummary, SourceRef, WikiArticleOverview } from "#lib/types.ts";

export function usePanelCard(scope: DocumentScope = "vault") {
  let selectedCard = $state<SourceRef | null>(null);
  let trail = $state<ReadingTrail | null>(null);

  function select(card: SourceRef | null, next: ReadingTrail | null = null) {
    selectedCard = card;
    trail = next;
  }

  function openArticle(article: WikiArticleOverview) {
    select({
      type: "article",
      label: article.file_path,
      document_id: null,
      title: article.title,
      scope: null,
      path: null,
      thinking: null,
    });
  }

  function openSource(source: SourceDocumentSummary) {
    select({
      type: "raw",
      label: source.file_path,
      document_id: source.id,
      title: source.title,
      scope: null,
      path: null,
      thinking: null,
    });
  }

  function openSourceArticle(slug: string, title: string) {
    select({
      type: "article",
      label: `wiki/${slug}.md`,
      document_id: null,
      title,
      scope: null,
      path: null,
      thinking: null,
    });
  }

  function openPath(path: string, chunk: number | null = null) {
    select({
      type: path.startsWith("wiki/") ? "article" : "raw",
      label: path,
      document_id: null,
      title: null,
      scope: null,
      path: null,
      thinking: null,
      ranges: chunk === null ? undefined : [{ start: chunk, end: chunk }],
      full: scope === "personal" || chunk === null,
    });
  }

  function toggle(source: SourceRef) {
    select(
      selectedCard?.label === source.label
        ? null
        : { ...source, ranges: source.ranges?.map((range) => ({ ...range })) },
    );
  }

  function openTrail(next: ReadingTrail) {
    if (selectedCard?.label === next.step.source.label && next.focus === null) select(null);
    else select({ ...next.step.source }, next);
  }

  const focus = $derived.by(() => {
    const range = selectedCard?.ranges?.length === 1 ? selectedCard.ranges[0] : null;
    return trail?.focus ?? (range && range.start === range.end ? range.start : null);
  });

  function href(chunk: number | null) {
    const card = selectedCard;
    if (!card) return null;
    const hash = chunk === null ? "" : `#^p${chunk}`;
    return scope === "vault" && card.type === "raw" && card.document_id
      ? `/source/${card.document_id}${hash}`
      : `${scope === "personal" ? "/refs/" : "/doc/"}${card.label}${hash}`;
  }

  function maximize() {
    const target = href(focus);
    if (target === null) return;
    select(null);
    void goto(target);
  }

  return {
    get selectedCard() {
      return selectedCard;
    },
    get trail() {
      return trail;
    },
    get focus() {
      return focus;
    },
    passageHref: (chunk: number) => href(chunk),
    close() {
      select(null);
    },
    maximize,
    onLinkClick: createLinkInterceptor(({ path, chunk }) => openPath(path, chunk)),
    openArticle,
    openPath,
    openSource,
    openSourceArticle,
    openTrail,
    toggle,
  };
}
