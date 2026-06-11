import { Effect } from "effect";
import type { Db } from "@great-minds/db/context";
import type { QueryAnswer, QueryRequest } from "@great-minds/domain/query";
import { LlmClient, type LlmProviderError } from "./llm.js";
import { loadWorkspace, VaultUnavailable, type VaultScope } from "./workspace.js";

export function answerQuery(
  scope: VaultScope,
  query: QueryRequest,
): Effect.Effect<QueryAnswer, VaultUnavailable | LlmProviderError, LlmClient | Db> {
  return Effect.gen(function* () {
    yield* loadWorkspace(scope);

    const llm = yield* LlmClient;
    const completion = yield* llm.complete({
      model: query.model,
      messages: [...query.history, { role: "user", content: query.question }],
    });

    return { answer: completion.content };
  });
}
