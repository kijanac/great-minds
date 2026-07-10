import { Effect } from "effect";

type DatabaseDefect =
  | { readonly _tag: "SqlError" }
  | { readonly _tag: "EffectDrizzleQueryError" };

const isDatabaseDefect = (error: unknown): error is DatabaseDefect =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  (error._tag === "SqlError" || error._tag === "EffectDrizzleQueryError");

export const dieDatabase = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, Exclude<E, DatabaseDefect>, R> =>
  effect.pipe(Effect.catchIf(isDatabaseDefect, (error) => Effect.die(error))) as Effect.Effect<
    A,
    Exclude<E, DatabaseDefect>,
    R
  >;
