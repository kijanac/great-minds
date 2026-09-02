import { Cause, type Duration, Effect } from "effect";

import { StructuredLogger } from "./logging.ts";

export const backgroundLoop = <E, R>(options: {
  readonly failureEvent: string;
  readonly interval: Duration.Input;
  readonly tick: Effect.Effect<unknown, E, R>;
}) =>
  Effect.gen(function* () {
    const logger = yield* StructuredLogger;
    const tick = options.tick.pipe(
      Effect.catchCause((cause) =>
        logger.warn(options.failureEvent, { error_message: Cause.pretty(cause) }),
      ),
    );
    yield* tick;
    yield* Effect.forkScoped(
      Effect.forever(Effect.sleep(options.interval).pipe(Effect.andThen(tick))),
    );
  });
