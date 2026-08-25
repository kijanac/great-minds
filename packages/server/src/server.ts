import { createServer, type Server } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import {
  AuthMiddleware,
  BadRequest,
  CurrentAuth,
  Forbidden,
  GreatMindsApi,
  ServiceUnavailable,
  Unauthorized,
  type DomainError,
  type Uuid,
} from "@great-minds/domain";
import { Cause, Effect, Layer, ManagedRuntime, Option, Redacted, Stream } from "effect";
import {
  HttpMiddleware,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as Multipart from "effect/unstable/http/Multipart";
import * as HttpServerError from "effect/unstable/http/HttpServerError";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpApiSchemaError } from "effect/unstable/httpapi/HttpApiError";

import { AppLayerLive, type AppLayerServices } from "./app-layer.ts";
import { AuthService } from "./auth.ts";
import { AppConfig } from "./config.ts";
import { CostsService } from "./costs.ts";
import { DocumentRegistryMismatch, DocumentsService } from "./documents.ts";
import { domainErrorResponse } from "./http-errors.ts";
import { IngestService } from "./ingest.ts";
import { JobsService } from "./jobs.ts";
import { LintService } from "./lint.ts";
import { StructuredLogger } from "./logging.ts";
import { PasskeysService } from "./passkeys.ts";
import { ProposalsService } from "./proposals.ts";
import { QueryService } from "./query.ts";
import { RepliesService } from "./replies.ts";
import { SessionsService } from "./sessions.ts";
import { SharesService } from "./shares.ts";
import { SourcesService } from "./sources.ts";
import { UserDocumentsService } from "./user-documents.ts";
import { VaultAccessService, VaultsService } from "./vaults.ts";
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
const heartbeatBytes = new TextEncoder().encode(": heartbeat\n\n");

export const jobSseHeartbeatChunk = (chunk: Uint8Array) =>
  chunk.length === 1 && chunk[0] === 10 ? heartbeatBytes : chunk;

const clean500Response = jsonResponse(500, { detail: "Internal Server Error" });

// Keep the version nibble in lockstep with the domain Uuid schema (accepts v1-v8).
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const parseUuidPathParam = (value: string | undefined) =>
  value !== undefined && UUID_PATTERN.test(value) ? (value as Uuid) : undefined;

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
      Validation: domainErrorJsonResponse,
      BadRequest: domainErrorJsonResponse,
      Conflict: domainErrorJsonResponse,
      ServiceUnavailable: domainErrorJsonResponse,
    }),
  );

const withDomainJson = <A, E extends DomainError, R>(
  effect: Effect.Effect<A, E, R>,
  status: number,
) =>
  withDomainErrors(effect).pipe(
    Effect.flatMap((value) =>
      HttpServerResponse.isHttpServerResponse(value)
        ? Effect.succeed(value)
        : jsonResponse(status, value),
    ),
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

const firstDefect = (cause: Cause.Cause<unknown>) => cause.reasons.find(Cause.isDieReason)?.defect;

const defectFields = (cause: Cause.Cause<unknown>) => {
  const defect = firstDefect(cause);
  if (defect instanceof Error) {
    return {
      error_message: defect.message,
      stack: defect.stack,
    };
  }
  if (defect !== undefined) {
    return {
      error_message: String(defect),
      stack: undefined,
    };
  }
  return {
    error_message: Cause.pretty(cause),
    stack: undefined,
  };
};

const handleHttpCause = (cause: Cause.Cause<unknown>) =>
  Effect.gen(function* () {
    const schemaError = schemaErrorFromCause(cause);
    if (schemaError !== undefined) {
      return yield* schemaErrorResponse(schemaError);
    }

    const defect = firstDefect(cause);
    if (defect instanceof DocumentRegistryMismatch) {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const logger = yield* StructuredLogger;
      yield* logger.error("document_registry_mismatch", {
        method: request.method,
        path: request.url,
        document_path: defect.path,
        status: 500,
      });
      return yield* jsonResponse(500, { detail: defect.message });
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
      ...defectFields(cause),
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
      }),
  })),
);

const MetaHandlersLive = HttpApiBuilder.group(MountedGreatMindsApi, "meta", (handlers) =>
  handlers.handle("health", () => Effect.succeed({ status: "ok" as const })),
);

const AuthHandlersLive = HttpApiBuilder.group(MountedGreatMindsApi, "auth", (handlers) =>
  handlers
    .handle("requestCode", ({ payload }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const auth = yield* AuthService;
          yield* auth.requestCode(payload.email);
        }),
      ),
    )
    .handle("verifyCode", ({ payload }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const auth = yield* AuthService;
          return yield* auth.verifyCode(payload.email, payload.code);
        }),
      ),
    )
    .handle("refresh", ({ payload }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const auth = yield* AuthService;
          return yield* auth.refresh(payload.refresh_token);
        }),
      ),
    )
    .handle("passkeyRegisterOptions", () =>
      withDomainErrors(
        Effect.gen(function* () {
          const passkeys = yield* PasskeysService;
          const current = yield* CurrentAuth;
          return yield* passkeys.registrationOptions(current.user_id, current.email);
        }),
      ),
    )
    .handle("registerPasskey", ({ payload }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const passkeys = yield* PasskeysService;
          const current = yield* CurrentAuth;
          return yield* passkeys.register(current.user_id, payload);
        }),
      ),
    )
    .handle("passkeyAuthenticationOptions", () =>
      withDomainErrors(
        Effect.gen(function* () {
          const passkeys = yield* PasskeysService;
          return yield* passkeys.authenticationOptions();
        }),
      ),
    )
    .handle("verifyPasskey", ({ payload }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const passkeys = yield* PasskeysService;
          return yield* passkeys.verify(payload);
        }),
      ),
    )
    .handle("listPasskeys", () =>
      withDomainErrors(
        Effect.gen(function* () {
          const passkeys = yield* PasskeysService;
          const current = yield* CurrentAuth;
          return yield* passkeys.list(current.user_id);
        }),
      ),
    )
    .handle("deletePasskey", ({ params }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const passkeys = yield* PasskeysService;
          const current = yield* CurrentAuth;
          yield* passkeys.delete(current.user_id, params.id);
        }),
      ),
    )
    .handle("createApiKey", ({ payload }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const auth = yield* AuthService;
          const current = yield* CurrentAuth;
          return yield* auth.createApiKey(current.user_id, payload.label);
        }),
      ),
    )
    .handle("listApiKeys", () =>
      withDomainErrors(
        Effect.gen(function* () {
          const auth = yield* AuthService;
          const current = yield* CurrentAuth;
          return yield* auth.listApiKeys(current.user_id);
        }),
      ),
    )
    .handle("deleteApiKey", ({ params }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const auth = yield* AuthService;
          const current = yield* CurrentAuth;
          yield* auth.revokeApiKey(current.user_id, params.key_id);
        }),
      ),
    )
    .handle("deleteMe", () =>
      withDomainErrors(
        Effect.gen(function* () {
          const auth = yield* AuthService;
          const current = yield* CurrentAuth;
          yield* auth.deleteSelf(current.user_id);
        }),
      ),
    ),
);

const RefsHandlersLive = HttpApiBuilder.group(MountedGreatMindsApi, "refs", (handlers) =>
  handlers
    .handle("createReference", ({ payload }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const documents = yield* UserDocumentsService;
          const current = yield* CurrentAuth;
          const result = yield* documents.create(current.user_id, payload.url);
          return result.created
            ? result.reference
            : yield* jsonResponse(200, result.reference);
        }),
      ),
    )
    .handle("listReferences", ({ query }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const documents = yield* UserDocumentsService;
          const current = yield* CurrentAuth;
          return yield* documents.list(current.user_id, query);
        }),
      ),
    )
    .handle("readReference", ({ params }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const documents = yield* UserDocumentsService;
          const current = yield* CurrentAuth;
          return yield* documents.read(current.user_id, params["*"]);
        }),
      ),
    )
    .handle("deleteReference", ({ params }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const documents = yield* UserDocumentsService;
          const current = yield* CurrentAuth;
          yield* documents.delete(current.user_id, params["*"]);
        }),
      ),
    )
    .handle("updateReference", ({ params, payload }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const documents = yield* UserDocumentsService;
          const current = yield* CurrentAuth;
          return yield* documents.update(current.user_id, params["*"], payload);
        }),
      ),
    ),
);

const VaultHandlersLive = HttpApiBuilder.group(MountedGreatMindsApi, "vaults", (handlers) =>
  handlers
    .handle("listVaults", ({ query }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const vaultsService = yield* VaultsService;
          const current = yield* CurrentAuth;
          return yield* vaultsService.listVaults(current.user_id, query);
        }),
      ),
    )
    .handle("createVault", ({ payload }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const vaultsService = yield* VaultsService;
          const current = yield* CurrentAuth;
          return yield* vaultsService.createVault(current.user_id, payload);
        }),
      ),
    )
    .handle("draftVaultHint", ({ payload }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const query = yield* QueryService;
          const current = yield* CurrentAuth;
          return yield* query.draftHint(current.user_id, payload.description);
        }),
      ),
    )
    .handle("getVault", ({ params }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const vaultsService = yield* VaultsService;
          const current = yield* CurrentAuth;
          return yield* vaultsService.getVaultDetail(current.user_id, params.vault_id);
        }),
      ),
    )
    .handle("getVaultConfig", ({ params }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const vaultsService = yield* VaultsService;
          const current = yield* CurrentAuth;
          return yield* vaultsService.getVaultConfig(current.user_id, params.vault_id);
        }),
      ),
    )
    .handle("updateVaultConfig", ({ params, payload }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const vaultsService = yield* VaultsService;
          const current = yield* CurrentAuth;
          return yield* vaultsService.updateVaultConfig(current.user_id, params.vault_id, payload);
        }),
      ),
    )
    .handle("listVaultMembers", ({ params, query }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const vaultsService = yield* VaultsService;
          const current = yield* CurrentAuth;
          return yield* vaultsService.listMembers(current.user_id, params.vault_id, query);
        }),
      ),
    )
    .handle("inviteVaultMember", ({ params, payload }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const vaultsService = yield* VaultsService;
          const current = yield* CurrentAuth;
          return yield* vaultsService.inviteMember(current.user_id, params.vault_id, payload);
        }),
      ),
    )
    .handle("updateVaultMember", ({ params, payload }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const vaultsService = yield* VaultsService;
          const current = yield* CurrentAuth;
          return yield* vaultsService.updateMemberRole(
            current.user_id,
            params.vault_id,
            params.member_user_id,
            payload.role,
          );
        }),
      ),
    )
    .handle("removeVaultMember", ({ params }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const vaultsService = yield* VaultsService;
          const current = yield* CurrentAuth;
          yield* vaultsService.removeMember(
            current.user_id,
            params.vault_id,
            params.member_user_id,
          );
        }),
      ),
    )
    .handle("transferVaultOwnership", ({ params, payload }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const vaultsService = yield* VaultsService;
          const current = yield* CurrentAuth;
          yield* vaultsService.transferOwnership(current.user_id, params.vault_id, payload);
        }),
      ),
    )
    .handle("deleteVault", ({ params }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const vaultsService = yield* VaultsService;
          const current = yield* CurrentAuth;
          yield* vaultsService.deleteVault(current.user_id, params.vault_id);
        }),
      ),
    ),
);

const WikiHandlersLive = HttpApiBuilder.group(MountedGreatMindsApi, "wiki", (handlers) =>
  handlers
    .handle("listWikiArticles", ({ params, query }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const wiki = yield* WikiService;
          const current = yield* CurrentAuth;
          return yield* wiki.listArticles(current.user_id, params.vault_id, query);
        }),
      ),
    )
    .handle("listRecentWikiArticles", ({ params, query }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const wiki = yield* WikiService;
          const current = yield* CurrentAuth;
          return yield* wiki.listRecent(current.user_id, params.vault_id, query);
        }),
      ),
    ),
);

const SourcesHandlersLive = HttpApiBuilder.group(MountedGreatMindsApi, "sources", (handlers) =>
  handlers
    .handle("listSources", ({ params, query }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const sources = yield* SourcesService;
          const current = yield* CurrentAuth;
          return yield* sources.listSources(current.user_id, params.vault_id, query);
        }),
      ),
    )
    .handle("deleteSource", ({ params }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const sources = yield* SourcesService;
          const current = yield* CurrentAuth;
          yield* sources.deleteSource(current.user_id, params.vault_id, params["*"]);
        }),
      ),
    )
    .handle("requestSourceDeletion", ({ params }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const sources = yield* SourcesService;
          const current = yield* CurrentAuth;
          const suffix = "/deletion-request";
          const rawPath = params["*"];
          if (!rawPath.endsWith(suffix)) {
            return yield* new BadRequest({ detail: `Invalid source path: ${rawPath}` });
          }
          return yield* sources.requestSourceDeletion(
            current.user_id,
            params.vault_id,
            rawPath.slice(0, -suffix.length),
          );
        }),
      ),
    ),
);

const ProposalsHandlersLive = HttpApiBuilder.group(MountedGreatMindsApi, "proposals", (handlers) =>
  handlers
    .handle("listProposals", ({ params, query }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const proposals = yield* ProposalsService;
          const current = yield* CurrentAuth;
          return yield* proposals.list(current.user_id, params.vault_id, query);
        }),
      ),
    )
    .handle("createProposal", ({ params, payload }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const proposals = yield* ProposalsService;
          const current = yield* CurrentAuth;
          return yield* proposals.create(current.user_id, params.vault_id, payload);
        }),
      ),
    )
    .handle("getProposal", ({ params }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const proposals = yield* ProposalsService;
          const current = yield* CurrentAuth;
          return yield* proposals.get(current.user_id, params.vault_id, params.proposal_id);
        }),
      ),
    )
    .handle("reviewProposal", ({ params, payload }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const proposals = yield* ProposalsService;
          const current = yield* CurrentAuth;
          return yield* proposals.review(
            current.user_id,
            params.vault_id,
            params.proposal_id,
            payload,
          );
        }),
      ),
    ),
);

const IngestHandlersLive = HttpApiBuilder.group(MountedGreatMindsApi, "ingest", (handlers) =>
  handlers
    .handle("ingestRaw", ({ params, payload }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const ingest = yield* IngestService;
          const current = yield* CurrentAuth;
          return yield* ingest.ingestRaw(current.user_id, params.vault_id, payload);
        }),
      ),
    )
    .handle("promoteReference", ({ params, payload }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const ingest = yield* IngestService;
          const current = yield* CurrentAuth;
          const result = yield* ingest.promoteReference(
            current.user_id,
            params.vault_id,
            payload,
          );
          return result.created
            ? result.document
            : yield* jsonResponse(200, result.document);
        }),
      ),
    )
    .handle("ingestUserSuggestion", ({ params, payload }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const ingest = yield* IngestService;
          const current = yield* CurrentAuth;
          return yield* ingest.ingestUserSuggestion(current.user_id, params.vault_id, payload);
        }),
      ),
    )
    .handle("checkStagedFileDupes", ({ params, payload }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const ingest = yield* IngestService;
          const current = yield* CurrentAuth;
          const existing = yield* ingest.checkStagedDupes(
            current.user_id,
            params.vault_id,
            payload.client_hashes,
          );
          return { existing: [...existing] };
        }),
      ),
    )
    .handle("signStagedFiles", ({ params, payload }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const ingest = yield* IngestService;
          const current = yield* CurrentAuth;
          const signed = yield* ingest.signStagedFiles(
            current.user_id,
            params.vault_id,
            payload.files,
          );
          return { files: [...signed] };
        }),
      ),
    )
    .handle("processStagedFiles", ({ params, payload }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const ingest = yield* IngestService;
          const current = yield* CurrentAuth;
          return yield* ingest.processStagedFiles(
            current.user_id,
            params.vault_id,
            payload.job_id,
            payload.files,
          );
        }),
      ),
    ),
);

const JobsHandlersLive = HttpApiBuilder.group(MountedGreatMindsApi, "jobs", (handlers) =>
  handlers
    .handle("startUrlJob", ({ params, payload }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const ingest = yield* IngestService;
          const current = yield* CurrentAuth;
          return yield* ingest.startUrlJob(current.user_id, params.vault_id, payload);
        }),
      ),
    )
    .handle("listJobs", ({ params, query }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const jobs = yield* JobsService;
          const current = yield* CurrentAuth;
          return yield* jobs.list(current.user_id, params.vault_id, query);
        }),
      ),
    )
    .handle("getJob", ({ params }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const jobs = yield* JobsService;
          const current = yield* CurrentAuth;
          return yield* jobs.get(current.user_id, params.vault_id, params.job_id);
        }),
      ),
    )
    .handle("streamJob", ({ params }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const jobs = yield* JobsService;
          const current = yield* CurrentAuth;
          return yield* jobs.stream(current.user_id, params.vault_id, params.job_id);
        }),
      ),
    ),
);

const CompileHandlersLive = HttpApiBuilder.group(MountedGreatMindsApi, "compile", (handlers) =>
  handlers
    .handle("requestCompile", ({ params, payload }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const current = yield* CurrentAuth;
          const access = yield* VaultAccessService;
          yield* access.requireOwner(current.user_id, params.vault_id);
          const config = yield* AppConfig;
          if (Option.isNone(config.openRouterApiKey)) {
            return yield* new ServiceUnavailable({
              detail: "LLM service not configured (OPENROUTER_API_KEY missing)",
            });
          }
          const jobs = yield* JobsService;
          return yield* jobs.requestCompile(current.user_id, params.vault_id, payload.job_id);
        }),
      ),
    )
    .handle("cancelCompile", ({ params }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const jobs = yield* JobsService;
          const current = yield* CurrentAuth;
          yield* jobs.cancelCompile(current.user_id, params.vault_id, params.run_id);
        }),
      ),
    ),
);

const LintHandlersLive = HttpApiBuilder.group(MountedGreatMindsApi, "lint", (handlers) =>
  handlers.handle("getLint", ({ params }) =>
    withDomainErrors(
      Effect.gen(function* () {
        const lint = yield* LintService;
        const current = yield* CurrentAuth;
        return yield* lint.report(current.user_id, params.vault_id);
      }),
    ),
  ),
);

const CostsHandlersLive = HttpApiBuilder.group(MountedGreatMindsApi, "costs", (handlers) =>
  handlers
    .handle("getUserCosts", ({ query }) =>
      Effect.gen(function* () {
        const costs = yield* CostsService;
        const current = yield* CurrentAuth;
        return yield* costs.forUser(current.user_id, query);
      }),
    )
    .handle("getVaultCosts", ({ params, query }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const costs = yield* CostsService;
          const current = yield* CurrentAuth;
          return yield* costs.forVault(current.user_id, params.vault_id, query);
        }),
      ),
    ),
);

const DocumentsHandlersLive = HttpApiBuilder.group(MountedGreatMindsApi, "documents", (handlers) =>
  handlers
    .handle("readDocument", ({ params }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const documents = yield* DocumentsService;
          const current = yield* CurrentAuth;
          return yield* documents.readDocument(current.user_id, params.vault_id, params["*"]);
        }),
      ),
    )
    .handle("readChunks", ({ params, query }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const documents = yield* DocumentsService;
          const current = yield* CurrentAuth;
          return yield* documents.readChunks(current.user_id, params.vault_id, query);
        }),
      ),
    )
    .handle("readLinks", ({ params, query }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const documents = yield* DocumentsService;
          const current = yield* CurrentAuth;
          return yield* documents.readLinks(current.user_id, params.vault_id, query);
        }),
      ),
    ),
);

const SessionsHandlersLive = HttpApiBuilder.group(MountedGreatMindsApi, "sessions", (handlers) =>
  handlers
    .handle("createSession", ({ params, payload }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const sessions = yield* SessionsService;
          const current = yield* CurrentAuth;
          return yield* sessions.createSession(current.user_id, params.vault_id, payload);
        }),
      ),
    )
    .handle("appendSessionExchange", ({ params, payload }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const sessions = yield* SessionsService;
          const current = yield* CurrentAuth;
          return yield* sessions.appendExchange(
            current.user_id,
            params.vault_id,
            params.session_id,
            payload,
          );
        }),
      ),
    )
    .handle("appendSessionBtw", ({ params, payload }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const sessions = yield* SessionsService;
          const current = yield* CurrentAuth;
          return yield* sessions.appendBtw(
            current.user_id,
            params.vault_id,
            params.session_id,
            payload,
          );
        }),
      ),
    )
    .handle("promoteSessionExchange", ({ params }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const sessions = yield* SessionsService;
          const current = yield* CurrentAuth;
          return yield* sessions.promoteExchange(
            current.user_id,
            params.vault_id,
            params.session_id,
            params.exchange_id,
          );
        }),
      ),
    )
    .handle("listSessions", ({ params, query }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const sessions = yield* SessionsService;
          const current = yield* CurrentAuth;
          return yield* sessions.listSessions(current.user_id, params.vault_id, query);
        }),
      ),
    )
    .handle("listSessionsByOrigin", ({ params, query }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const sessions = yield* SessionsService;
          const current = yield* CurrentAuth;
          return yield* sessions.listSessionsByOrigin(
            current.user_id,
            params.vault_id,
            query.doc_path,
          );
        }),
      ),
    )
    .handle("readSession", ({ params }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const sessions = yield* SessionsService;
          const current = yield* CurrentAuth;
          return yield* sessions.readSession(current.user_id, params.vault_id, params.session_id);
        }),
      ),
    )
    .handle("readSessionMarkdown", ({ params }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const sessions = yield* SessionsService;
          const current = yield* CurrentAuth;
          return yield* sessions.readMarkdown(current.user_id, params.vault_id, params.session_id);
        }),
      ),
    ),
);

const RepliesHandlersLive = HttpApiBuilder.group(MountedGreatMindsApi, "replies", (handlers) =>
  handlers
    .handle("createReply", ({ params, payload }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const replies = yield* RepliesService;
          const current = yield* CurrentAuth;
          return yield* replies.create(current.user_id, params.vault_id, payload);
        }),
      ),
    )
    .handle("streamReply", ({ params }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const replies = yield* RepliesService;
          const current = yield* CurrentAuth;
          return yield* replies.stream(current.user_id, params.vault_id, params.reply_id);
        }),
      ),
    ),
);

const SharesHandlersLive = HttpApiBuilder.group(MountedGreatMindsApi, "shares", (handlers) =>
  handlers
    .handle("createShare", ({ payload }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const shares = yield* SharesService;
          const current = yield* CurrentAuth;
          if (current.credential_kind === "api_key") {
            return yield* new Forbidden({
              detail: "Share creation requires session authentication",
            });
          }
          return yield* shares.create(current.user_id, payload);
        }),
      ),
    )
    .handle("listShares", () =>
      withDomainErrors(
        Effect.gen(function* () {
          const shares = yield* SharesService;
          const current = yield* CurrentAuth;
          return yield* shares.listMine(current.user_id);
        }),
      ),
    )
    .handle("deleteShare", ({ params }) =>
      withDomainErrors(
        Effect.gen(function* () {
          const shares = yield* SharesService;
          const current = yield* CurrentAuth;
          yield* shares.revoke(current.user_id, params.share_id);
        }),
      ),
    ),
);

const PublicHandlersLive = HttpApiBuilder.group(MountedGreatMindsApi, "public", (handlers) =>
  handlers.handle("resolveShare", ({ params }) =>
    withDomainErrors(
      Effect.gen(function* () {
        const shares = yield* SharesService;
        const detail = yield* shares.resolve(params.token);
        return HttpServerResponse.setHeaders(HttpServerResponse.jsonUnsafe(detail), {
          "X-Robots-Tag": "noindex",
          "Referrer-Policy": "no-referrer",
        });
      }),
    ),
  ),
);

const StreamHeadersLive = HttpRouter.middleware(
  (effect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const response = yield* effect;
      const pathname = new URL(request.url, "http://localhost").pathname;
      if (
        response.status === 200 &&
        pathname.startsWith("/v1/vaults/") &&
        request.method === "GET" &&
        pathname.endsWith("/stream")
      ) {
        const withHeaders = HttpServerResponse.setHeaders(response, {
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        if (response.body._tag === "Stream") {
          return HttpServerResponse.setBody(
            withHeaders,
            HttpBody.stream(
              response.body.stream.pipe(Stream.map(jobSseHeartbeatChunk)),
              "text/event-stream",
            ),
          );
        }
        return withHeaders;
      }
      return response;
    }),
  { global: true },
);

const bearerFromRequest = (request: HttpServerRequest.HttpServerRequest) => {
  const header = request.headers.authorization;
  if (header === undefined || !header.startsWith("Bearer ")) {
    return undefined;
  }
  return header.slice("Bearer ".length);
};

const currentAuthFromRequest = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const token = bearerFromRequest(request);
    if (token === undefined || token.length === 0) {
      return yield* domainErrorJsonResponse(new Unauthorized({ detail: "Missing bearer token" }));
    }
    const auth = yield* AuthService;
    const current = yield* Effect.result(auth.authenticateBearer(token));
    if (current._tag === "Failure") {
      return yield* domainErrorJsonResponse(current.failure);
    }
    return current.success;
  });

const parseUpload = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const parts = Array.from(
      yield* Stream.runCollect(request.multipartStream).pipe(
        Effect.mapError(() => new BadRequest({ detail: "Invalid multipart upload" })),
      ),
    );
    const file = parts.find((part) => Multipart.isFile(part) && part.key === "file");
    if (file === undefined || !Multipart.isFile(file)) {
      return yield* new BadRequest({ detail: "Uploaded file must have a filename" });
    }
    if (file.name.length === 0) {
      return yield* new BadRequest({ detail: "Uploaded file must have a filename" });
    }
    const rawBytes = yield* file.contentEffect.pipe(
      Effect.mapError(() => new BadRequest({ detail: "Invalid multipart upload" })),
    );
    const url = new URL(request.url, "http://localhost");
    return {
      rawBytes,
      filename: file.name,
      mimetype: file.contentType,
      origin: url.searchParams.get("origin") ?? undefined,
      destPath: url.searchParams.get("dest_path"),
    };
  });

const UploadRouteLive = HttpRouter.add("POST", "/v1/vaults/:vault_id/ingest/upload", (request) =>
  Effect.gen(function* () {
    const params = yield* HttpRouter.params;
    const vaultId = parseUuidPathParam(params.vault_id);
    if (vaultId === undefined) {
      return yield* jsonResponse(422, { detail: "Invalid path parameter" });
    }
    const current = yield* currentAuthFromRequest(request);
    if (HttpServerResponse.isHttpServerResponse(current)) {
      return current;
    }
    const upload = yield* parseUpload(request).pipe(
      Effect.catchTags({
        BadRequest: domainErrorJsonResponse,
      }),
    );
    if (HttpServerResponse.isHttpServerResponse(upload)) {
      return upload;
    }
    const ingest = yield* IngestService;
    return yield* withDomainJson(ingest.ingestUpload(current.user_id, vaultId, upload), 201);
  }),
);

const ApiGroupsLive = Layer.mergeAll(
  MetaHandlersLive,
  AuthHandlersLive,
  RefsHandlersLive,
  VaultHandlersLive,
  WikiHandlersLive,
  SourcesHandlersLive,
  ProposalsHandlersLive,
  IngestHandlersLive,
  JobsHandlersLive,
  CompileHandlersLive,
  LintHandlersLive,
  CostsHandlersLive,
  DocumentsHandlersLive,
  SessionsHandlersLive,
  RepliesHandlersLive,
  SharesHandlersLive,
  PublicHandlersLive,
).pipe(Layer.provideMerge(AuthMiddlewareLive));

const ApiLive = HttpApiBuilder.layer(MountedGreatMindsApi).pipe(Layer.provide(ApiGroupsLive));

const AppRoutesLive = Layer.mergeAll(
  StreamHeadersLive,
  HttpRouter.add("GET", "/health", healthResponse),
  HttpRouter.add("GET", "/", healthResponse),
  UploadRouteLive,
  ApiLive,
);

const ServerLive = (nodeServer: Server, options: StartServerOptions) => {
  const appLayer = options.layer ?? AppLayerLive;
  const nodeLayer = Layer.unwrap(
    Effect.map(AppConfig, (config) =>
      NodeHttpServer.layer(() => nodeServer, {
        host: options.host ?? config.serverHost,
        port: options.port ?? config.serverPort,
      }),
    ),
  );
  const serveLayer = Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const httpEffect = yield* HttpRouter.toHttpEffect(AppRoutesLive);
      // The browser talks to this API cross-origin from the static frontend, so it
      // needs CORS preflight handling and Allow-Origin headers. Mirrors the Python
      // config: credentialed, all methods, the headers the client actually sends.
      const cors = HttpMiddleware.cors({
        allowedOrigins: config.corsOrigins,
        allowedMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization"],
        credentials: true,
        maxAge: 86_400,
      });
      return HttpServer.serve()(
        cors(
          Effect.matchCauseEffect(httpEffect, {
            onFailure: handleHttpCause,
            onSuccess: Effect.succeed,
          }),
        ),
      );
    }),
  );

  return serveLayer.pipe(
    Layer.provideMerge(nodeLayer),
    Layer.provideMerge(appLayer),
  ) as Layer.Layer<RuntimeServices, unknown, never>;
};

const formatUrl = (address: HttpServer.Address) => {
  if (address._tag === "UnixAddress") {
    return `unix://${address.path}`;
  }
  const host =
    address.hostname === "0.0.0.0" || address.hostname === "::" ? "127.0.0.1" : address.hostname;
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
    },
  };
};
