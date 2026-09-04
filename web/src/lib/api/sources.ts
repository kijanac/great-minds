import type {
  FacetCount,
  Proposal,
  SourceDocumentPage,
  SourceDocumentSummary,
  Uuid,
} from "@great-minds/domain";

import { api, run } from "./app";
import { selectedVault } from "./selected-vault";

export type { SourceDocumentPage, SourceDocumentSummary };
export type SourceTypeFacet = FacetCount;

export function fetchSourceDocuments(params: {
  source_type?: string;
  search?: string;
  tag?: string;
  limit: number;
  offset?: number;
}): Promise<SourceDocumentPage> {
  const query = {
    limit: params.limit,
    offset: params.offset ?? 0,
    ...(params.source_type !== undefined ? { source_type: params.source_type } : {}),
    ...(params.search !== undefined ? { search: params.search } : {}),
    ...(params.tag !== undefined ? { tag: params.tag } : {}),
  };
  return run(api.sources.listSources({ params: { vault_id: selectedVault() }, query }));
}

export function deleteSourceDocument(sourceId: Uuid): Promise<void> {
  return run(
    api.sources.deleteSource({
      params: { vault_id: selectedVault(), source_id: sourceId },
    }),
  );
}

export function requestSourceDeletion(sourceId: Uuid): Promise<Proposal> {
  return run(
    api.sources.requestSourceDeletion({
      params: { vault_id: selectedVault(), source_id: sourceId },
    }),
  );
}
