import type { DomainError } from "@great-minds/domain";
import { Data, Duration, Effect, Schema, Stream } from "effect";
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

const gatewayUnavailable = new Set([502, 503, 504]);

const reconnectable = (error: HttpClientError.HttpClientError) => {
  switch (error.reason._tag) {
    case "TransportError":
      return true;
    case "DecodeError":
    case "StatusCodeError": {
      const status = error.reason.response.status;
      return (status >= 200 && status < 300) || gatewayUnavailable.has(status);
    }
    default:
      return false;
  }
};

export const followSnapshots = <A>(
  connect: Stream.Stream<Sse.EventEncoded, StreamFailure>,
  schema: Schema.Decoder<A>,
  isTerminal: (snapshot: A) => boolean,
): Stream.Stream<A, StreamFailure> => {
  const decode = Schema.decodeEffect(Schema.fromJsonString(schema));

  function attempt(count: number): Stream.Stream<A, StreamFailure> {
    return connect.pipe(
      Stream.concat(Stream.fail(new Disconnected())),
      Stream.takeWhile((event) => event.event !== "done"),
      Stream.filter((event) => event.event === "message" && event.data.length > 0),
      Stream.mapEffect((event) => decode(event.data)),
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
