import { Effect } from "effect";

export function firstOrFail<A, E>(rows: readonly A[], onEmpty: () => E): Effect.Effect<A, E> {
  const first = rows[0];
  return first === undefined ? Effect.fail(onEmpty()) : Effect.succeed(first);
}

export function parseOrFail<A, E>(parse: () => A, onError: () => E): Effect.Effect<A, E> {
  return Effect.try({ try: parse, catch: onError });
}
