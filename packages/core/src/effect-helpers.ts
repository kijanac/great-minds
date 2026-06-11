import { Effect } from "effect";

export function firstOrFail<A, E>(rows: readonly A[], onEmpty: () => E): Effect.Effect<A, E> {
  const first = rows[0];
  return first === undefined ? Effect.fail(onEmpty()) : Effect.succeed(first);
}

export function firstOrDie<A>(rows: readonly A[], message: string): Effect.Effect<A> {
  const first = rows[0];
  return first === undefined ? Effect.die(new Error(message)) : Effect.succeed(first);
}
