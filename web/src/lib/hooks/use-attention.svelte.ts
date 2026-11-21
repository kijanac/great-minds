import { createQuery } from "@tanstack/svelte-query";

import { fetchAttention } from "#lib/api/attention.ts";
import { activeVault } from "#lib/hooks/use-vault.svelte.ts";

export type AttentionItem = { readonly text: string; readonly href?: string };
export type AttentionGroup = {
  readonly count: number;
  readonly label: string;
  readonly items: readonly AttentionItem[];
};

const group = (
  items: readonly AttentionItem[],
  one: string,
  many: string,
  count = items.length,
): AttentionGroup[] => (count === 0 ? [] : [{ count, label: count === 1 ? one : many, items }]);

export function useAttention() {
  const query = createQuery(() => ({
    queryKey: ["vault", activeVault.id, "attention"],
    queryFn: () => fetchAttention(activeVault.id!),
    enabled: !!activeVault.id,
  }));

  const updateGroups = $derived.by(() => {
    const report = query.data;
    if (!report) return [];
    return [
      ...group(
        report.unwritten_articles.map((text) => ({ text })),
        "article not written",
        "articles not written",
      ),
      ...group([], "new source", "new sources", report.new_sources),
    ];
  });
  const adminGroups = $derived.by(() => {
    const report = query.data;
    if (!report) return [];
    return [
      ...group(
        report.unread_sources.map((source) => ({
          text: source.title,
          href: `/source/${source.id}`,
        })),
        "source could not be read",
        "sources could not be read",
      ),
      ...group(
        report.left_out_files.map((text) => ({ text })),
        "file could not be added",
        "files could not be added",
      ),
      ...group(
        report.unsearchable_sources.map((text) => ({ text, href: `/doc/${text}` })),
        "source cannot be searched",
        "sources cannot be searched",
      ),
      ...group(
        report.unplaced_links.map((link) => ({
          text: `${link.source_title} → ${link.target_title}`,
          href: `/doc/wiki/${link.source_slug}.md`,
        })),
        "link missing from its article",
        "links missing from their article",
      ),
    ];
  });

  return {
    get adminGroups() {
      return adminGroups;
    },
    get checking() {
      return query.isFetching;
    },
    retry: () => query.refetch(),
    get status(): "loading" | "ready" | "unavailable" {
      if (query.isError) return "unavailable";
      if (query.data) return "ready";
      return "loading";
    },
    get updateGroups() {
      return updateGroups;
    },
  };
}
