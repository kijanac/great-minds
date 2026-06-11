import { Context, Effect, Layer } from "effect";
import { Db, type BackendDb } from "@great-minds/db/context";
import type { QueryAnswer, QueryRequest } from "@great-minds/domain/query";
import { LlmClient, type LlmClientService, type LlmProviderError } from "./llm.js";
import { loadWorkspaceWith, VaultUnavailable, type VaultScope } from "./workspace.js";

export type QueryServiceShape = {
  readonly answer: (scope: VaultScope, query: QueryRequest) => Effect.Effect<QueryAnswer, VaultUnavailable | LlmProviderError>;
};

export class QueryService extends Context.Service<
  QueryService,
  QueryServiceShape
>()("QueryService") {}

export const QueryServiceLive = Layer.effect(
  QueryService,
  Effect.gen(function* () {
    const db = yield* Db;
    const llm = yield* LlmClient;

    return QueryService.of({
      answer: (scope, query) => answerQueryWith(db, llm, scope, query),
    });
  }),
);

function answerQueryWith(
  db: BackendDb,
  llm: LlmClientService,
  scope: VaultScope,
  query: QueryRequest,
): Effect.Effect<QueryAnswer, VaultUnavailable | LlmProviderError> {
  return Effect.gen(function* () {
    yield* loadWorkspaceWith(db, scope);

    const completion = yield* llm.complete({
      model: query.model,
      messages: [...query.history, { role: "user", content: query.question }],
    });

    return { answer: completion.content };
  });
}
