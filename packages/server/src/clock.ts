import { Context, Effect, Layer } from "effect";

type ClockServiceShape = {
  readonly now: Effect.Effect<Date>;
};

export class ClockService extends Context.Service<ClockService, ClockServiceShape>()(
  "@great-minds/server/ClockService"
) {}

export const ClockLive = Layer.succeed(ClockService, {
  now: Effect.sync(() => new Date())
});

export const makeTestClock = (initial: Date) => {
  let current = initial;
  return {
    layer: Layer.succeed(ClockService, {
      now: Effect.sync(() => current)
    }),
    set: (next: Date) => {
      current = next;
    }
  };
};
