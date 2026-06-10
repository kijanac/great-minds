import type { DbSession } from "@great-minds/db/context";
import type { QueryAnswer, QueryRequest } from "@great-minds/domain/query";
import { loadWorkspace, type VaultScope } from "./workspace.js";

export async function answerQuery(
  db: DbSession,
  scope: VaultScope,
  query: QueryRequest,
  complete: (request: {
    model: string;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
  }) => Promise<{ answer: string }>,
): Promise<QueryAnswer> {
  await loadWorkspace(db, scope);

  return complete({
    model: query.model,
    messages: [...query.history, { role: "user", content: query.question }],
  });
}
