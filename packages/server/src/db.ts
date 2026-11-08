import { layerPgClient } from "@great-minds/database";
import { Effect, Layer } from "effect";

import { AppConfig } from "./config.ts";

export const PgClientLive = Layer.unwrap(
  Effect.map(AppConfig, (config) => layerPgClient({ url: config.databaseUrl })),
);
