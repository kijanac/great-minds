import { Effect } from "effect";
import type { DbSession } from "@great-minds/db/context";
import type { QueryAnswer, QueryRequest } from "@great-minds/domain/query";
import { LlmClient, LlmProviderError } from "./llm.js";
import { loadWorkspace, VaultUnavailable, type VaultScope } from "./workspace.js";

export function answerQuery(
  db: DbSession,
  scope: VaultScope,
  query: QueryRequest,
): Effect.Effect<QueryAnswer, VaultUnavailable | LlmProviderError, LlmClient> {
  return Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => loadWorkspace(db, scope),
      catch: () => new VaultUnavailable(),
    });

    const llm = yield* LlmClient;
    const completion = yield* llm.complete({
      model: query.model,
      messages: [...query.history, { role: "user", content: query.question }],
    });

    return { answer: completion.content };
  });
}
