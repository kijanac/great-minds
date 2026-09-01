import { AuthMiddleware, GreatMindsApi } from "@great-minds/domain";
import { Effect, Semaphore } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";

import { TokenStore, type TokenStoreShape } from "./token-store";

type Renew = (staleRefresh: string) => Effect.Effect<string | null>;

type Send = (
  request: HttpClientRequest.HttpClientRequest,
) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>;

export type Authenticate = (options: {
  readonly request: HttpClientRequest.HttpClientRequest;
  readonly next: Send;
}) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>;

const withBearer = (request: HttpClientRequest.HttpClientRequest, token: string | null) =>
  token === null ? request : request.pipe(HttpClientRequest.bearerToken(token));

const makeRenew = (baseUrl: string) =>
  Effect.gen(function* () {
    const tokens = yield* TokenStore;
    const httpClient = yield* HttpClient.HttpClient;
    const refresh = yield* HttpApiClient.endpoint(GreatMindsApi, {
      group: "auth",
      endpoint: "refresh",
      httpClient,
      baseUrl,
    });
    const oneAtATime = yield* Semaphore.make(1);

    const exchange = (staleRefresh: string) =>
      Effect.gen(function* () {
        const pair = yield* refresh({ payload: { refresh_token: staleRefresh } });
        yield* tokens.write(pair);
        return pair.access_token;
      });

    const renewUnlessAlreadyRenewed = (staleRefresh: string) =>
      Effect.gen(function* () {
        const current = yield* tokens.read;
        if (current.refresh !== staleRefresh) return current.access;
        return yield* exchange(staleRefresh);
      }).pipe(
        Effect.catchTag("Unauthorized", () => tokens.clear.pipe(Effect.as(null))),
        Effect.catch(() => Effect.succeed(null)),
      );

    const renew: Renew = (staleRefresh) =>
      oneAtATime.withPermits(1)(renewUnlessAlreadyRenewed(staleRefresh));
    return renew;
  });

const authenticate =
  (tokens: TokenStoreShape, renew: Renew): Authenticate =>
  ({ request, next }) =>
    Effect.gen(function* () {
      const stored = yield* tokens.read;
      const response = yield* next(withBearer(request, stored.access));
      if (response.status !== 401 || stored.refresh === null) return response;
      const renewed = yield* renew(stored.refresh);
      if (renewed === null) return response;
      return yield* next(withBearer(request, renewed));
    });

export const makeAuthenticate = (baseUrl: string) =>
  Effect.gen(function* () {
    const tokens = yield* TokenStore;
    const renew = yield* makeRenew(baseUrl);
    return authenticate(tokens, renew);
  });

export const makeAuthMiddlewareClient = (baseUrl: string) =>
  HttpApiMiddleware.layerClient(AuthMiddleware, makeAuthenticate(baseUrl));
