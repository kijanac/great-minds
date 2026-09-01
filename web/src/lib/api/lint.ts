import { type LintReport, type UnmentionedLink, Uuid } from "@great-minds/domain";
import { Schema } from "effect";

import { api, run } from "./app";

export type { UnmentionedLink };

const uuid = Schema.decodeSync(Uuid);

export async function fetchLintResults(vaultId: string): Promise<LintReport> {
  return run(api.lint.getLint({ params: { vault_id: uuid(vaultId) } }));
}
