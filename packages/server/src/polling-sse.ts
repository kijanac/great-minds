import { Effect, Stream } from "effect";
import type { EventEncoded } from "effect/unstable/encoding/Sse";

type Snapshot = {
  readonly version: string | number;
  readonly data: string;
  readonly terminal: boolean;
};

export const pollingSse = <A>(
  id: string,
  read: Effect.Effect<A | undefined>,
  snapshot: (row: A) => Snapshot,
  pollIntervalMs: number,
): Stream.Stream<EventEncoded> => Stream.suspend(() => {
  const identity = JSON.stringify({ id });
  let previousVersion: string | number | undefined;
  let heartbeatAt = Date.now() + 30_000;
  let first = true;

  const poll = Effect.gen(function* () {
    if (!first) yield* Effect.sleep(pollIntervalMs);
    first = false;
    const row = yield* read;
    const events: EventEncoded[] = [];
    if (row !== undefined) {
      const current = snapshot(row);
      if (current.version !== previousVersion) {
        previousVersion = current.version;
        events.push({ event: "message", data: current.data });
        if (current.terminal) {
          events.push({ event: "done", data: identity });
          return events;
        }
      }
    }
    if (Date.now() >= heartbeatAt) {
      events.push({ event: "message", data: "" });
      heartbeatAt = Date.now() + 30_000;
    }
    return events;
  });

  return Stream.concat(
    Stream.fromIterable<EventEncoded>([{ event: "connected", data: identity }]),
    Stream.fromIterableEffectRepeat(poll),
  ).pipe(
    Stream.takeUntil((event) => event.event === "done"),
    Stream.rechunk(1),
  );
});
