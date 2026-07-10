import * as PgClient from "@effect/sql-pg/PgClient";
import { DatabaseLive } from "@great-minds/database";
import { Effect, Layer } from "effect";

import { AppConfig } from "./config.ts";

export const PgClientLive = Layer.unwrap(
  Effect.map(AppConfig, (config) => PgClient.layer({ url: config.databaseUrl }))
);

export const DrizzleLive = DatabaseLive.pipe(Layer.provide(PgClientLive));
