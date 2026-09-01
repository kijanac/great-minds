import {
  Uuid,
  type FacetCount,
  type Proposal,
  type SourceDocumentPage,
  type SourceDocumentSummary,
} from "@great-minds/domain";
import { Schema } from "effect";

import { getVaultId } from "../vault-selection";

import { api, run } from "./app";

export type { SourceDocumentPage, SourceDocumentSummary };
export type SourceTypeFacet = FacetCount;

const uuid = Schema.decodeSync(Uuid);

function selectedVault(): Uuid {
  const id = getVaultId();
  if (id === null) throw new Error("No vault selected");
  return uuid(id);
}

export async function fetchSourceDocuments(params: {
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

export async function deleteSourceDocument(sourceId: string): Promise<void> {
  return run(
    api.sources.deleteSource({
      params: { vault_id: selectedVault(), source_id: uuid(sourceId) },
    }),
  );
}

export async function requestSourceDeletion(sourceId: string): Promise<Proposal> {
  return run(
    api.sources.requestSourceDeletion({
      params: { vault_id: selectedVault(), source_id: uuid(sourceId) },
    }),
  );
}
