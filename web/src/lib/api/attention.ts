import type { AttentionReport, Uuid } from "@great-minds/domain";

import { api, run } from "./app";

export function fetchAttention(vaultId: Uuid): Promise<AttentionReport> {
  return run(api.attention.getAttention({ params: { vault_id: vaultId } }));
}
