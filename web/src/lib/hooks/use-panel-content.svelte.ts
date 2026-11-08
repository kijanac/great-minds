import { createQuery } from "@tanstack/svelte-query";

import type { DocumentScope } from "#lib/api/doc.ts";
import { activeVault } from "#lib/hooks/use-vault.svelte.ts";
import { loadPanelContent } from "#lib/panel-content.ts";
import type { SourceRef } from "#lib/types.ts";

export function usePanelContent(
  selectedCard: () => SourceRef | null,
  scope: DocumentScope = "vault",
) {
  return createQuery(() => {
    const card = selectedCard();
    return {
      queryKey: [
        scope === "personal" ? "me" : "vault",
        scope === "personal" ? "ref" : activeVault.id,
        "article-panel",
        card?.type,
        card?.document_id,
        card?.label,
        card?.ranges,
        card?.full,
      ],
      queryFn: ({ signal }) => loadPanelContent(card!, scope, signal),
      enabled: !!card && (scope === "personal" || !!activeVault.id),
    };
  });
}
