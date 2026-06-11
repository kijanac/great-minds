import { Layer, ManagedRuntime } from "effect";
import { LlmClient } from "@great-minds/core/llm";
import { openRouterLlmClient } from "@great-minds/core/openrouter";
import { createDbLayer, Db, type BackendDbConfig } from "@great-minds/db/context";
import type { ApiConfig } from "./context.js";

export type ApiRuntime = ManagedRuntime.ManagedRuntime<Db | LlmClient, never>;

export async function createApiRuntime(dbConfig: BackendDbConfig, config: ApiConfig): Promise<ApiRuntime> {
  const appLayer = createDbLayer(dbConfig).pipe(
    Layer.merge(Layer.succeed(LlmClient, openRouterLlmClient(config.openAiProvider))),
  );
  const runtime = ManagedRuntime.make(appLayer);
  await runtime.runPromise(Db);
  return runtime;
}
