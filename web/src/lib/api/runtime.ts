import { GreatMindsApi, type DomainError } from "@great-minds/domain";
import { Data, Effect, Layer, ManagedRuntime, Stream, type Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import { makeAuthenticate, makeAuthMiddlewareClient } from "./auth-middleware";
import type { StreamFailure } from "./sse";
import { TokenStore } from "./token-store";

export class ApiError extends Data.TaggedError("ApiError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export type RequestFailure = DomainError | ApiError;

type ClientFailure = DomainError | HttpClientError.HttpClientError | Schema.SchemaError;

const transportMessage = (reason: HttpClientError.HttpClientErrorReason): string => {
  switch (reason._tag) {
    case "StatusCodeError":
    case "DecodeError":
      return `Request failed (${reason.response.status})`;
    case "TransportError":
      return "Network error";
    case "EmptyBodyError":
      return "Unexpected response";
    case "EncodeError":
    case "InvalidUrlError":
      return "Invalid request";
  }
};

export const withApiErrors = <A, R>(effect: Effect.Effect<A, ClientFailure, R>) =>
  effect.pipe(
    Effect.catchTags({
      HttpClientError: (error) =>
        Effect.fail(new ApiError({ message: transportMessage(error.reason), cause: error })),
      SchemaError: (error) =>
        Effect.fail(new ApiError({ message: "Unexpected response", cause: error })),
    }),
  );

const withStreamErrors = <A, R>(stream: Stream.Stream<A, StreamFailure, R>) =>
  stream.pipe(
    Stream.catchTags({
      HttpClientError: (error) =>
        Stream.fail(new ApiError({ message: transportMessage(error.reason), cause: error })),
      SchemaError: (error) =>
        Stream.fail(new ApiError({ message: "Unexpected response", cause: error })),
      SseError: (error) => Stream.fail(new ApiError({ message: "Stream failed", cause: error })),
      Retry: (retry) => Stream.fail(new ApiError({ message: "Stream interrupted", cause: retry })),
    }),
  );

const abortedSignal = (signal: AbortSignal) =>
  Effect.callback<void>((resume) => {
    if (signal.aborted) {
      resume(Effect.void);
      return;
    }
    const finish = () => resume(Effect.void);
    signal.addEventListener("abort", finish, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", finish));
  });

const abortError = () => new DOMException("The operation was aborted", "AbortError");

const rethrowAsAbort = (signal: AbortSignal | undefined, error: unknown): never => {
  throw signal?.aborted ? abortError() : error;
};

async function* abortAware<A>(source: AsyncIterable<A>, signal: AbortSignal): AsyncIterable<A> {
  try {
    yield* source;
  } catch (error) {
    rethrowAsAbort(signal, error);
  }
  if (signal.aborted) throw abortError();
}

export interface RunOptions {
  readonly signal?: AbortSignal;
}

export interface ApiOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly tokens: Layer.Layer<TokenStore>;
}

export const makeApi = (options: ApiOptions) => {
  const transport = Layer.mergeAll(
    FetchHttpClient.layer,
    Layer.succeed(FetchHttpClient.Fetch, options.fetch),
    options.tokens,
  );
  const services = makeAuthMiddlewareClient(options.baseUrl).pipe(Layer.provideMerge(transport));
  const runtime = ManagedRuntime.make(services);
  const context = runtime.runSync(runtime.contextEffect);
  const api = runtime.runSync(HttpApiClient.make(GreatMindsApi, { baseUrl: options.baseUrl }));
  const authenticate = runtime.runSync(makeAuthenticate(options.baseUrl));
  const transportClient = runtime.runSync(HttpClient.HttpClient);
  const authenticatedClient = HttpClient.transform(transportClient, (_, request) =>
    authenticate({ request, next: (authenticated) => transportClient.execute(authenticated) }),
  );
  const http = HttpClient.mapRequest(
    authenticatedClient,
    HttpClientRequest.prependUrl(options.baseUrl),
  );

  const run = <A>(
    effect: Effect.Effect<A, ClientFailure, Layer.Success<typeof services>>,
    runOptions?: RunOptions,
  ): Promise<A> =>
    runtime
      .runPromise(withApiErrors(effect), runOptions)
      .catch((error: unknown) => rethrowAsAbort(runOptions?.signal, error));

  const stream = <A>(
    source: Stream.Stream<A, StreamFailure, Layer.Success<typeof services>>,
    signal?: AbortSignal,
  ): AsyncIterable<A> => {
    const events = Stream.toAsyncIterableWith(withStreamErrors(source), context);
    if (signal === undefined) return events;
    const halted = Stream.haltWhen(source, abortedSignal(signal));
    return abortAware(Stream.toAsyncIterableWith(withStreamErrors(halted), context), signal);
  };

  return { api, http, run, stream };
};

export type Api = ReturnType<typeof makeApi>["api"];
