import type { DomainError } from "@great-minds/domain";
import { Data, Duration, Effect, Stream, type Schema } from "effect";
import type * as Sse from "effect/unstable/encoding/Sse";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";

export type StreamFailure =
  | DomainError
  | HttpClientError.HttpClientError
  | Schema.SchemaError
  | Sse.SseError
  | Sse.Retry;

class Disconnected extends Data.TaggedError("Disconnected") {}

const reconnectDelay = (attempt: number) => Duration.millis(Math.min(1000 * 2 ** attempt, 10_000));

const reconnectable = (error: HttpClientError.HttpClientError) =>
  error.reason._tag === "TransportError";

export const followUntil = <A>(
  connect: Stream.Stream<A, StreamFailure>,
  isTerminal: (event: A) => boolean,
): Stream.Stream<A, StreamFailure> => {
  function attempt(count: number): Stream.Stream<A, StreamFailure> {
    return connect.pipe(
      Stream.concat(Stream.fail(new Disconnected())),
      Stream.takeUntil(isTerminal),
      Stream.catchTags({
        Disconnected: () => reconnectAfter(reconnectDelay(count), count),
        SseError: () => reconnectAfter(reconnectDelay(count), count),
        Retry: (retry) => reconnectAfter(retry.duration, count),
        HttpClientError: (error) =>
          reconnectable(error) ? reconnectAfter(reconnectDelay(count), count) : Stream.fail(error),
      }),
    );
  }

  function reconnectAfter(
    delay: Duration.Duration,
    count: number,
  ): Stream.Stream<A, StreamFailure> {
    return Stream.unwrap(Effect.as(Effect.sleep(delay), attempt(count + 1)));
  }

  return attempt(0);
};
