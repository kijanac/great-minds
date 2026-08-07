import * as PgDrizzle from "drizzle-orm/effect-postgres";
import {
  EffectDrizzleError,
  EffectDrizzleQueryError,
  EffectTransactionRollbackError,
} from "drizzle-orm/effect-core/errors";
import { Context, Effect, Layer } from "effect";
import { SqlError } from "effect/unstable/sql/SqlError";

export type DrizzleClient = Effect.Success<ReturnType<typeof PgDrizzle.makeWithDefaults>>;
export type TransactionClient = Parameters<Parameters<DrizzleClient["transaction"]>[0]>[0];
export type DatabaseInfraError =
  | SqlError
  | EffectDrizzleError
  | EffectDrizzleQueryError
  | EffectTransactionRollbackError;

const isInfraError = (error: unknown): error is DatabaseInfraError =>
  error instanceof SqlError ||
  error instanceof EffectDrizzleError ||
  error instanceof EffectDrizzleQueryError ||
  error instanceof EffectTransactionRollbackError;

const stripInfraErrors = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, Exclude<E, DatabaseInfraError>, R> =>
  effect.pipe(Effect.catchIf(isInfraError, Effect.die)) as Effect.Effect<
    A,
    Exclude<E, DatabaseInfraError>,
    R
  >;

export class Database extends Context.Service<
  Database,
  {
    readonly query: <A, E, R>(
      f: (db: DrizzleClient) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, Exclude<E, DatabaseInfraError>, R>;
    readonly transaction: <A, E, R>(
      f: (tx: TransactionClient) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, Exclude<E, DatabaseInfraError>, R>;
  }
>()("@great-minds/database/Database") {}

export const DatabaseLive = Layer.effect(
  Database,
  PgDrizzle.makeWithDefaults().pipe(
    Effect.map((client) => ({
      query: <A, E, R>(f: (db: DrizzleClient) => Effect.Effect<A, E, R>) =>
        stripInfraErrors(f(client)),
      transaction: <A, E, R>(f: (tx: TransactionClient) => Effect.Effect<A, E, R>) =>
        stripInfraErrors(client.transaction(f)),
    })),
  ),
);
