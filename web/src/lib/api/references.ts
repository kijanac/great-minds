import {
  Uuid,
  type IngestedDocument,
  type ReferenceDetail,
  type ReferenceOverview,
  type ReferencePage,
} from "@great-minds/domain";
import { Schema } from "effect";

import { api, run } from "./app";

export type { IngestedDocument, ReferenceDetail, ReferenceOverview, ReferencePage };

const uuid = Schema.decodeSync(Uuid);

export async function promoteReference(vaultId: string, path: string): Promise<IngestedDocument> {
  return run(
    api.ingest.promoteReference({
      params: { vault_id: uuid(vaultId) },
      payload: { path },
    }),
  );
}

export async function renameReference(
  referenceId: string,
  title: string | null,
): Promise<ReferenceDetail> {
  return run(
    api.refs.updateReference({ params: { reference_id: uuid(referenceId) }, payload: { title } }),
  );
}
