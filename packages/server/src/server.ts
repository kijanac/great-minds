import { createServer, type Server } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import {
  AuthMiddleware,
  CurrentAuth,
  GreatMindsApi,
  type DomainError
} from "@great-minds/domain";
import { Cause, Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as HttpServerError from "effect/unstable/http/HttpServerError";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpApiSchemaError } from "effect/unstable/httpapi/HttpApiError";

import { AppLayerLive, type AppLayerServices } from "./app-layer.ts";
import { AuthService } from "./auth.ts";
import { AppConfig } from "./config.ts";
import { domainErrorResponse } from "./http-errors.ts";
import { StructuredLogger } from "./logging.ts";
import { SourcesService } from "./sources.ts";
import { VaultsService } from "./vaults.ts";
import { WikiService } from "./wiki.ts";

type RuntimeServices = AppLayerServices | HttpServer.HttpServer;

type StartServerOptions = {
  readonly layer?: Layer.Layer<AppLayerServices, unknown, never>;
  readonly host?: string;
  readonly port?: number;
};

type StartedServer = {
  readonly server: Server;
  readonly runtime: ManagedRuntime.ManagedRuntime<RuntimeServices, unknown>;
  readonly url: string;
  readonly close: () => Promise<void>;
};

const MountedGreatMindsApi = GreatMindsApi.prefix("/v1");

const jsonResponse = (status: number, body: unknown) =>
  HttpServerResponse.json(body, { status }).pipe(Effect.orDie);

const healthResponse = jsonResponse(200, { status: "ok" });

const clean500Response = jsonResponse(500, { detail: "Internal Server Error" });

const validationDetail = (error: HttpApiSchemaError) => {
  switch (error.kind) {
    case "Params":
      return "Invalid path parameter";
    case "Body":
    case "Payload":
      return "Invalid request body";
    case "Headers":
      return "Invalid request headers";
    case "Query":
      return "Invalid query parameters";
  }
};

const schemaErrorResponse = (error: HttpApiSchemaError) =>
  jsonResponse(422, { detail: validationDetail(error) });

const domainErrorJsonResponse = (error: DomainError) => {
  const response = domainErrorResponse(error);
  return jsonResponse(response.status, response.body);
};

const withDomainErrors = <A, E extends DomainError, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchTags({
      Unauthorized: domainErrorJsonResponse,
      Forbidden: domainErrorJsonResponse,
      NotFound: domainErrorJsonResponse,
      Validation: domainErrorJsonResponse
    })
  );

const schemaErrorFromCause = (cause: Cause.Cause<unknown>) => {
  for (const reason of cause.reasons) {
    if (Cause.isDieReason(reason) && HttpApiSchemaError.is(reason.defect)) {
      return reason.defect;
    }
    if (Cause.isFailReason(reason) && HttpApiSchemaError.is(reason.error)) {
      return reason.error;
    }
  }
  return undefined;
};

const defectFields = (cause: Cause.Cause<unknown>) => {
  const defect = cause.reasons.find(Cause.isDieReason)?.defect;
  if (defect instanceof Error) {
    return {
      error_message: defect.message,
      stack: defect.stack
    };
  }
  if (defect !== undefined) {
    return {
      error_message: String(defect),
      stack: undefined
    };
  }
  return {
    error_message: Cause.pretty(cause),
    stack: undefined
  };
};

const handleHttpCause = (cause: Cause.Cause<unknown>) =>
  Effect.gen(function* () {
    const schemaError = schemaErrorFromCause(cause);
    if (schemaError !== undefined) {
      return yield* schemaErrorResponse(schemaError);
    }

    const [response] = yield* HttpServerError.causeResponse(cause);
    if (response.status < 500) {
      return response;
    }

    const request = yield* HttpServerRequest.HttpServerRequest;
    const logger = yield* StructuredLogger;
    yield* logger.error("http_request_failed", {
      method: request.method,
      path: request.url,
      status: 500,
      ...defectFields(cause)
    });
    return yield* clean500Response;
  });

const AuthMiddlewareLive = Layer.effect(
  AuthMiddleware,
  Effect.map(AuthService, (auth) => ({
    bearer: (httpEffect, { credential }) =>
      Effect.gen(function* () {
        const token = Redacted.value(credential);
        const current = yield* Effect.result(auth.authenticateBearer(token));
        if (current._tag === "Failure") {
          return yield* domainErrorJsonResponse(current.failure);
        }
        return yield* Effect.provideService(httpEffect, CurrentAuth, current.success);
      })
  }))
);

const MetaHandlersLive = HttpApiBuilder.group(MountedGreatMindsApi, "meta", (handlers) =>
  handlers.handle("health", () => Effect.succeed({ status: "ok" as const }))
);

const AuthHandlersLive = HttpApiBuilder.group(MountedGreatMindsApi, "auth", (handlers) =>
  handlers
    .handle("requestCode", ({ payload }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const auth = yield* AuthService;
          yield* auth.requestCode(payload.email);
        })
      )
    )
    .handle("verifyCode", ({ payload }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const auth = yield* AuthService;
          return yield* auth.verifyCode(payload.email, payload.code);
        })
      )
    )
    .handle("refresh", ({ payload }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const auth = yield* AuthService;
          return yield* auth.refresh(payload.refresh_token);
        })
      )
    )
    .handle("createApiKey", ({ payload }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const auth = yield* AuthService;
          const current = yield* CurrentAuth;
          return yield* auth.createApiKey(current.user_id, payload.label);
        })
      )
    )
    .handle("listApiKeys", () =>
      withDomainErrors(
        Effect.gen(function* () {
          const auth = yield* AuthService;
          const current = yield* CurrentAuth;
          return yield* auth.listApiKeys(current.user_id);
        })
      )
    )
    .handle("deleteApiKey", ({ params }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const auth = yield* AuthService;
          const current = yield* CurrentAuth;
          yield* auth.revokeApiKey(current.user_id, params.key_id);
        })
      )
    )
    .handle("deleteMe", () =>
      withDomainErrors(
        Effect.gen(function* () {
          const auth = yield* AuthService;
          const current = yield* CurrentAuth;
          yield* auth.deleteSelf(current.user_id);
        })
      )
    )
);

const VaultHandlersLive = HttpApiBuilder.group(MountedGreatMindsApi, "vaults", (handlers) =>
  handlers
    .handle("listVaults", ({ query }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const vaultsService = yield* VaultsService;
          const current = yield* CurrentAuth;
          return yield* vaultsService.listVaults(current.user_id, query);
        })
      )
    )
    .handle("getVault", ({ params }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const vaultsService = yield* VaultsService;
          const current = yield* CurrentAuth;
          return yield* vaultsService.getVaultDetail(current.user_id, params.vault_id);
        })
      )
    )
    .handle("getVaultConfig", ({ params }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const vaultsService = yield* VaultsService;
          const current = yield* CurrentAuth;
          return yield* vaultsService.getVaultConfig(current.user_id, params.vault_id);
        })
      )
    )
    .handle("listVaultMembers", ({ params, query }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const vaultsService = yield* VaultsService;
          const current = yield* CurrentAuth;
          return yield* vaultsService.listMembers(current.user_id, params.vault_id, query);
        })
      )
    )
);

const WikiHandlersLive = HttpApiBuilder.group(MountedGreatMindsApi, "wiki", (handlers) =>
  handlers
    .handle("listWikiArticles", ({ params, query }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const wiki = yield* WikiService;
          const current = yield* CurrentAuth;
          return yield* wiki.listArticles(current.user_id, params.vault_id, query);
        })
      )
    )
    .handle("listRecentWikiArticles", ({ params, query }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const wiki = yield* WikiService;
          const current = yield* CurrentAuth;
          return yield* wiki.listRecent(current.user_id, params.vault_id, query);
        })
      )
    )
);

const SourcesHandlersLive = HttpApiBuilder.group(MountedGreatMindsApi, "sources", (handlers) =>
  handlers.handle("listSources", ({ params, query }) =>
    withDomainErrors(
      Effect.gen(function* () {
        const sources = yield* SourcesService;
        const current = yield* CurrentAuth;
        return yield* sources.listSources(current.user_id, params.vault_id, query);
      })
    )
  )
);

const ApiGroupsLive = Layer.mergeAll(
  MetaHandlersLive,
  AuthHandlersLive,
  VaultHandlersLive,
  WikiHandlersLive,
  SourcesHandlersLive
).pipe(Layer.provideMerge(AuthMiddlewareLive));

const ApiLive = HttpApiBuilder.layer(MountedGreatMindsApi).pipe(Layer.provide(ApiGroupsLive));

const AppRoutesLive = Layer.mergeAll(
  HttpRouter.add("GET", "/health", healthResponse),
  HttpRouter.add("GET", "/", healthResponse),
  ApiLive
);

const ServerLive = (nodeServer: Server, options: StartServerOptions) => {
  const appLayer = options.layer ?? AppLayerLive;
  const nodeLayer = Layer.unwrap(
    Effect.map(AppConfig, (config) =>
      NodeHttpServer.layer(() => nodeServer, {
        host: options.host ?? config.serverHost,
        port: options.port ?? config.serverPort
      })
    )
  );
  const serveLayer = Layer.unwrap(
    HttpRouter.toHttpEffect(AppRoutesLive).pipe(
      Effect.map((httpEffect) =>
        HttpServer.serve()(
          Effect.matchCauseEffect(httpEffect, {
            onFailure: handleHttpCause,
            onSuccess: Effect.succeed
          })
        )
      )
    )
  );

  return serveLayer.pipe(
    Layer.provideMerge(nodeLayer),
    Layer.provideMerge(appLayer)
  ) as Layer.Layer<RuntimeServices, unknown, never>;
};

const formatUrl = (address: HttpServer.Address) => {
  if (address._tag === "UnixAddress") {
    return `unix://${address.path}`;
  }
  const host = address.hostname === "0.0.0.0" || address.hostname === "::" ? "127.0.0.1" : address.hostname;
  return `http://${host}:${address.port}`;
};

export const startServer = async (options: StartServerOptions = {}): Promise<StartedServer> => {
  const nodeServer = createServer();
  const runtime = ManagedRuntime.make(ServerLive(nodeServer, options));
  const httpServer = await runtime.runPromise(HttpServer.HttpServer);
  return {
    server: nodeServer,
    runtime,
    url: formatUrl(httpServer.address),
    close: async () => {
      await runtime.dispose();
    }
  };
};
