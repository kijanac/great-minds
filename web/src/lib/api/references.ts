import type {
  IngestedDocument,
  ReferenceDetail,
  ReferenceOverview,
  ReferencePage,
  Uuid,
} from "@great-minds/domain";

import { api, run } from "./app";

export type { IngestedDocument, ReferenceDetail, ReferenceOverview, ReferencePage };

export function promoteReference(vaultId: Uuid, path: string): Promise<IngestedDocument> {
  return run(
    api.ingest.promoteReference({
      params: { vault_id: vaultId },
      payload: { path },
    }),
  );
}

export function renameReference(referenceId: Uuid, title: string | null): Promise<ReferenceDetail> {
  return run(
    api.refs.updateReference({ params: { reference_id: referenceId }, payload: { title } }),
  );
}
