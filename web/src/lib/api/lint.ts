import type { LintReport, UnmentionedLink, Uuid } from "@great-minds/domain";

import { api, run } from "./app";

export type { UnmentionedLink };

export function fetchLintResults(vaultId: Uuid): Promise<LintReport> {
  return run(api.lint.getLint({ params: { vault_id: vaultId } }));
}
