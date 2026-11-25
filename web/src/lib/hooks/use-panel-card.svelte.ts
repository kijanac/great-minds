import { goto } from "$app/navigation";
import { citationPath, citedPassage, passageId } from "@great-minds/domain";
import type { DocumentScope } from "#lib/api/doc.ts";
import type { LinkDestination } from "#lib/markdown-links.ts";
import type { ReadingTrail } from "#lib/research-steps.ts";
import type { SourceDocumentSummary, SourceRef, WikiArticleOverview } from "#lib/types.ts";

export function usePanelCard(scope: DocumentScope = "vault") {
  let selectedCard = $state<SourceRef | null>(null);
  let trail = $state<ReadingTrail | null>(null);

  function select(card: SourceRef | null, next: ReadingTrail | null = null) {
    selectedCard = card;
    trail = next;
  }

  const card = (
    type: "article" | "raw",
    label: string,
    title: string | null,
    document_id: SourceRef["document_id"] = null,
  ): SourceRef => ({ type, label, document_id, title, scope: null, path: null, thinking: null });

  const openArticle = (article: WikiArticleOverview) =>
    select(card("article", article.file_path, article.title));

  const openSource = (source: SourceDocumentSummary) =>
    select(card("raw", source.file_path, source.title, source.id));

  const openSourceArticle = (slug: string, title: string) =>
    select(card("article", `wiki/${slug}.md`, title));

  function openPath(path: string, chunk: number | null = null) {
    select({
      ...card(path.startsWith("wiki/") ? "article" : "raw", path, null),
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
    const hash = chunk === null ? "" : `#${passageId(chunk)}`;
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
    onLinkClick(link: LinkDestination, event: MouseEvent) {
      if (link.kind !== "wiki" && link.kind !== "raw") return;
      event.preventDefault();
      if (link.kind === "wiki") void goto(`/doc/${link.href}`);
      else openPath(citationPath(link.href), citedPassage(link.href));
    },
    openArticle,
    openPath,
    openSource,
    openSourceArticle,
    openTrail,
    toggle,
  };
}
