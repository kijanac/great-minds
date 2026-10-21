import * as PgClient from "@effect/sql-pg/PgClient";
import { Effect, Layer } from "effect";

import { AppConfig } from "./config.ts";

export const PgClientLive = Layer.unwrap(
  Effect.map(AppConfig, (config) => PgClient.layer({ url: config.databaseUrl }))
);
