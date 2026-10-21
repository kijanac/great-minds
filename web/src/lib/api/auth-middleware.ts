import { AuthMiddleware, GreatMindsApi } from "@great-minds/domain";
import { Context, Effect } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";

import { TokenStore, type StoredTokens } from "./token-store";

type Send = (
  request: HttpClientRequest.HttpClientRequest,
) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>;

type Authenticate = (options: {
  readonly request: HttpClientRequest.HttpClientRequest;
  readonly next: Send;
}) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>;

export class AuthClient extends Context.Service<AuthClient, Authenticate>()("web/AuthClient") {}

const withBearer = (request: HttpClientRequest.HttpClientRequest, token: string | null) =>
  token === null ? request : request.pipe(HttpClientRequest.bearerToken(token));

export const makeAuthenticate = (baseUrl: string) =>
  Effect.gen(function* () {
    const tokens = yield* TokenStore;
    const httpClient = yield* HttpClient.HttpClient;
    const refresh = yield* HttpApiClient.endpoint(GreatMindsApi, {
      group: "auth",
      endpoint: "refresh",
      httpClient,
      baseUrl,
    });
    const renew = (stale: StoredTokens) =>
      tokens.exclusive(
        Effect.gen(function* () {
          const current = yield* tokens.read;
          if (current.session !== stale.session || current.refresh === null) return null;
          if (current.refresh !== stale.refresh) return current.access;
          const pair = yield* refresh({
            payload: { refresh_token: current.refresh },
          });
          const stored = yield* tokens.replaceIfCurrent(current, pair);
          return stored ? pair.access_token : null;
        }).pipe(
          Effect.catchTag("Unauthorized", () =>
            Effect.as(tokens.replaceIfCurrent(stale, null), null),
          ),
          Effect.catch(() => Effect.succeed(null)),
        ),
      );

    const authenticate: Authenticate = ({ request, next }) =>
      Effect.gen(function* () {
        const stored = yield* tokens.read;
        const response = yield* next(withBearer(request, stored.access));
        if (response.status !== 401 || stored.refresh === null) return response;
        const renewed = yield* renew(stored);
        if (renewed === null) return response;
        return yield* next(withBearer(request, renewed));
      });

    return authenticate;
  });

export const AuthMiddlewareClientLive = HttpApiMiddleware.layerClient(AuthMiddleware, AuthClient);
