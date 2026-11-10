import { createServer, type Server } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import {
  AuthMiddleware,
  BadRequest,
  CurrentAuth,
  endpointPermissions,
  type EndpointName,
  modelEndpoints,
  Forbidden,
  GreatMindsApi,
  type Permission,
  ServiceUnavailable,
  Validation,
  type DomainError,
  type Uuid,
} from "@great-minds/domain";
import ipaddr from "ipaddr.js";
import { Cause, Context, Effect, Layer, ManagedRuntime, Option, Redacted, Stream } from "effect";
import {
  HttpMiddleware,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { NetAddress } from "effect/net";
import * as HttpBody from "effect/http/HttpBody";
import * as Multipart from "effect/http/Multipart";
import * as HttpServerError from "effect/http/HttpServerError";
import { HttpApiBuilder } from "effect/http-api";
import { HttpApiSchemaError } from "effect/http-api/HttpApiError";

import { AppLayerLive, type AppLayerServices } from "./app-layer.ts";
import { AuthService, keyRefusal, modelRefusal } from "./auth.ts";
import { CliLogins } from "./cli-logins.ts";
import { Mailer } from "./mailer.ts";
import { AppConfig, missingModelKey, notConfiguredDetail } from "./config.ts";
import { CostsService } from "./costs.ts";
import { DocumentRegistryMismatch, DocumentsService } from "./documents.ts";
import { domainErrorResponse } from "./http-errors.ts";
import { FileIngestBatches } from "./file-ingest-batches.ts";
import { IngestService } from "./ingest.ts";
import { JobsService } from "./jobs.ts";
import { LintService } from "./lint.ts";
import { StructuredLogger } from "./logging.ts";
import { McpRoutesLive } from "./mcp.ts";
import { PasskeysService } from "./passkeys.ts";
import { ProposalsService } from "./proposals.ts";
import { QueryService } from "./query.ts";
import { RepliesService } from "./replies.ts";
import { SessionsService } from "./sessions.ts";
import { SessionExportsService } from "./publication/service.ts";
import { SharesService } from "./shares.ts";
import { parseCanonicalSourceUrl } from "./source-identity.ts";
import { UrlIngestService } from "./url-ingest.ts";
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

const asUser = <I, S, A, E, R>(
  service: Context.Key<I, S>,
  run: (service: S, userId: Uuid) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const current = yield* CurrentAuth;
    return yield* run(yield* service, current.user_id);
  });

const jsonResponse = (status: number, body: unknown) =>
  HttpServerResponse.json(body, { status }).pipe(Effect.orDie);

const healthResponse = jsonResponse(200, { status: "ok" });
const textEncoder = new TextEncoder();
const emptyMessageBytes = textEncoder.encode("data: \n\n");
const heartbeatBytes = textEncoder.encode(": heartbeat\n\n");

export const jobSseHeartbeatChunk = (chunk: Uint8Array) =>
  chunk.length === emptyMessageBytes.length &&
  chunk.every((byte, index) => byte === emptyMessageBytes[index])
    ? heartbeatBytes
    : chunk;

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
    case "ResponseHeaders":
      return "Invalid response headers";
  }
};

const schemaErrorResponse = (error: HttpApiSchemaError) =>
  domainErrorJsonResponse(new Validation({ detail: validationDetail(error) }));

const domainErrorJsonResponse = (error: DomainError) => {
  const response = domainErrorResponse(error);
  return jsonResponse(response.status, response.body);
};

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

const permissions = new Map<string, Permission>(Object.entries(endpointPermissions));

const AuthMiddlewareLive = Layer.effect(
  AuthMiddleware,
  Effect.map(AuthService, (auth) => ({
    bearer: (httpEffect, { credential, endpoint }) =>
      Effect.gen(function* () {
        const current = yield* auth.authenticateBearer(Redacted.value(credential));
        const refusal =
          keyRefusal(current, permissions.get(endpoint.identifier) ?? "account") ??
          (modelEndpoints.has(endpoint.identifier as EndpointName)
            ? modelRefusal(current)
            : undefined);
        if (refusal !== undefined) return yield* new Forbidden({ detail: refusal });
        return yield* Effect.provideService(httpEffect, CurrentAuth, current);
      }),
  })),
);

const throttleAddress = (raw: string) => {
  const candidate = raw.trim();
  if (!ipaddr.isValid(candidate)) return null;
  const address = ipaddr.process(candidate);
  if (address.kind() === "ipv4") return address.toString();
  return `${address.toNormalizedString().split(":").slice(0, 4).join(":")}::/64`;
};

const signInClientAddress = (
  request: HttpServerRequest.HttpServerRequest,
  header: Option.Option<string>,
) => {
  const forwarded = Option.flatMap(header, (name) => Option.fromNullishOr(request.headers[name]));
  const raw = Option.orElse(forwarded, () => request.remoteAddress);
  return Option.match(raw, { onNone: () => null, onSome: throttleAddress });
};

const MetaHandlersLive = HttpApiBuilder.group(MountedGreatMindsApi, "meta", (handlers) =>
  handlers.handle("health", () => Effect.succeed({ status: "ok" as const })),
);

const AuthHandlersLive = HttpApiBuilder.group(MountedGreatMindsApi, "auth", (handlers) =>
  handlers
    .handle("requestCode", ({ payload }) =>
      Effect.gen(function* () {
        const auth = yield* AuthService;
        const config = yield* AppConfig;
        const request = yield* HttpServerRequest.HttpServerRequest;
        yield* auth.requestCode(payload.email, signInClientAddress(request, config.clientIpHeader));
      }),
    )
    .handle("verifyCode", ({ payload }) =>
      Effect.gen(function* () {
        const auth = yield* AuthService;
        return yield* auth.verifyCode(payload.email, payload.code);
      }),
    )
    .handle("refresh", ({ payload }) =>
      Effect.gen(function* () {
        const auth = yield* AuthService;
        return yield* auth.refresh(payload.refresh_token);
      }),
    )
    .handle("passkeyRegisterOptions", () =>
      Effect.gen(function* () {
        const passkeys = yield* PasskeysService;
        const current = yield* CurrentAuth;
        return yield* passkeys.registrationOptions(current.user_id, current.email);
      }),
    )
    .handle("registerPasskey", ({ payload }) =>
      Effect.gen(function* () {
        const passkeys = yield* PasskeysService;
        const current = yield* CurrentAuth;
        return yield* passkeys.register(current.user_id, payload);
      }),
    )
    .handle("passkeyAuthenticationOptions", () =>
      Effect.gen(function* () {
        const passkeys = yield* PasskeysService;
        return yield* passkeys.authenticationOptions();
      }),
    )
    .handle("verifyPasskey", ({ payload }) =>
      Effect.gen(function* () {
        const passkeys = yield* PasskeysService;
        return yield* passkeys.verify(payload);
      }),
    )
    .handle("listPasskeys", () =>
      asUser(PasskeysService, (passkeys, userId) => passkeys.list(userId)),
    )
    .handle("deletePasskey", ({ params }) =>
      asUser(PasskeysService, (passkeys, userId) => passkeys.delete(userId, params.id)),
    )
    .handle("createApiKey", ({ payload }) =>
      asUser(AuthService, (auth, userId) =>
        auth.createApiKey(userId, payload.label, {
          vaultIds: payload.vault_ids,
          canAsk: payload.can_ask,
          canChange: payload.can_change,
          expiresAt: payload.expires_at,
        }),
      ),
    )
    .handle("listApiKeys", () => asUser(AuthService, (auth, userId) => auth.listApiKeys(userId)))
    .handle("deleteApiKey", ({ params }) =>
      Effect.gen(function* () {
        const current = yield* CurrentAuth;
        if (current.key_scope !== null && current.key_scope.key_id !== params.key_id)
          return yield* new Forbidden({ detail: "An API key can only revoke itself." });
        const auth = yield* AuthService;
        yield* auth.revokeApiKey(current.user_id, params.key_id);
      }),
    )
    .handle("getMe", () =>
      Effect.map(CurrentAuth, (current) => ({
        user_id: current.user_id,
        email: current.email,
        can_use_models: modelRefusal(current) === undefined,
        key: current.key_scope,
      })),
    )
    .handle("deleteMe", () =>
      asUser(VaultsService, (vaultsService, userId) => vaultsService.deleteAccount(userId)),
    )
    .handle("signInMethods", () => Effect.map(Mailer, (mailer) => ({ email: mailer.configured })))
    .handle("startCliLogin", ({ payload }) =>
      Effect.gen(function* () {
        const logins = yield* CliLogins;
        const config = yield* AppConfig;
        const request = yield* HttpServerRequest.HttpServerRequest;
        return yield* logins.start(
          payload.computer,
          signInClientAddress(request, config.clientIpHeader),
        );
      }),
    )
    .handle("pollCliLogin", ({ payload }) =>
      Effect.flatMap(CliLogins, (logins) => logins.poll(payload.device_code)),
    )
    .handle("getCliLogin", ({ query }) =>
      Effect.gen(function* () {
        const current = yield* CurrentAuth;
        const logins = yield* CliLogins;
        return yield* logins.describe(current.email, query.user_code);
      }),
    )
    .handle("approveCliLogin", ({ payload }) =>
      Effect.gen(function* () {
        const current = yield* CurrentAuth;
        const logins = yield* CliLogins;
        yield* logins.approve(current.user_id, payload.user_code);
      }),
    )
    .handle("denyCliLogin", ({ payload }) =>
      Effect.flatMap(CliLogins, (logins) => logins.deny(payload.user_code)),
    ),
);

const RefsHandlersLive = HttpApiBuilder.group(MountedGreatMindsApi, "refs", (handlers) =>
  handlers
    .handle("createReference", ({ payload }) =>
      Effect.gen(function* () {
        const documents = yield* UserDocumentsService;
        const current = yield* CurrentAuth;
        const canonicalUrl = yield* parseCanonicalSourceUrl(payload.url);
        const result = yield* documents.create(current.user_id, canonicalUrl);
        return result.created ? result.reference : yield* jsonResponse(200, result.reference);
      }),
    )
    .handle("listReferences", ({ query }) =>
      asUser(UserDocumentsService, (documents, userId) => documents.list(userId, query)),
    )
    .handle("resolveReference", ({ query }) =>
      asUser(UserDocumentsService, (documents, userId) => documents.read(userId, query.path)),
    )
    .handle("deleteReference", ({ params }) =>
      asUser(UserDocumentsService, (documents, userId) =>
        documents.delete(userId, params.reference_id),
      ),
    )
    .handle("updateReference", ({ params, payload }) =>
      asUser(UserDocumentsService, (documents, userId) =>
        documents.update(userId, params.reference_id, payload),
      ),
    ),
);

const VaultHandlersLive = HttpApiBuilder.group(MountedGreatMindsApi, "vaults", (handlers) =>
  handlers
    .handle("listVaults", ({ query }) =>
      asUser(VaultsService, (vaultsService, userId) => vaultsService.listVaults(userId, query)),
    )
    .handle("createVault", ({ payload }) =>
      asUser(VaultsService, (vaultsService, userId) => vaultsService.createVault(userId, payload)),
    )
    .handle("draftVaultHint", ({ payload }) =>
      asUser(QueryService, (query, userId) => query.draftHint(userId, payload.description)),
    )
    .handle("getVault", ({ params }) =>
      asUser(VaultsService, (vaultsService, userId) =>
        vaultsService.getVaultDetail(userId, params.vault_id),
      ),
    )
    .handle("renameVault", ({ params, payload }) =>
      asUser(VaultsService, (vaultsService, userId) =>
        vaultsService.renameVault(userId, params.vault_id, payload),
      ),
    )
    .handle("getVaultConfig", ({ params }) =>
      asUser(VaultsService, (vaultsService, userId) =>
        vaultsService.getVaultConfig(userId, params.vault_id),
      ),
    )
    .handle("updateVaultConfig", ({ params, payload }) =>
      asUser(VaultsService, (vaultsService, userId) =>
        vaultsService.updateVaultConfig(userId, params.vault_id, payload),
      ),
    )
    .handle("listVaultMembers", ({ params, query }) =>
      asUser(VaultsService, (vaultsService, userId) =>
        vaultsService.listMembers(userId, params.vault_id, query),
      ),
    )
    .handle("inviteVaultMember", ({ params, payload }) =>
      asUser(VaultsService, (vaultsService, userId) =>
        vaultsService.inviteMember(userId, params.vault_id, payload),
      ),
    )
    .handle("updateVaultMember", ({ params, payload }) =>
      asUser(VaultsService, (vaultsService, userId) =>
        vaultsService.updateMemberRole(
          userId,
          params.vault_id,
          params.member_user_id,
          payload.role,
        ),
      ),
    )
    .handle("removeVaultMember", ({ params }) =>
      asUser(VaultsService, (vaultsService, userId) =>
        vaultsService.removeMember(userId, params.vault_id, params.member_user_id),
      ),
    )
    .handle("transferVaultOwnership", ({ params, payload }) =>
      asUser(VaultsService, (vaultsService, userId) =>
        vaultsService.transferOwnership(userId, params.vault_id, payload),
      ),
    )
    .handle("deleteVault", ({ params }) =>
      asUser(VaultsService, (vaultsService, userId) =>
        vaultsService.deleteVault(userId, params.vault_id),
      ),
    ),
);

const WikiHandlersLive = HttpApiBuilder.group(MountedGreatMindsApi, "wiki", (handlers) =>
  handlers
    .handle("listWikiArticles", ({ params, query }) =>
      asUser(WikiService, (wiki, userId) => wiki.listArticles(userId, params.vault_id, query)),
    )
    .handle("listRecentWikiArticles", ({ params, query }) =>
      asUser(WikiService, (wiki, userId) => wiki.listRecent(userId, params.vault_id, query)),
    ),
);

const SourcesHandlersLive = HttpApiBuilder.group(MountedGreatMindsApi, "sources", (handlers) =>
  handlers
    .handle("listSources", ({ params, query }) =>
      asUser(SourcesService, (sources, userId) =>
        sources.listSources(userId, params.vault_id, query),
      ),
    )
    .handle("querySources", ({ params, payload }) =>
      asUser(SourcesService, (sources, userId) =>
        sources.querySources(userId, params.vault_id, payload),
      ),
    )
    .handle("readSource", ({ params }) =>
      asUser(DocumentsService, (documents, userId) =>
        documents.readSource(userId, params.vault_id, params.source_id),
      ),
    )
    .handle("deleteSource", ({ params }) =>
      asUser(SourcesService, (sources, userId) =>
        sources.deleteSource(userId, params.vault_id, params.source_id),
      ),
    )
    .handle("requestSourceDeletion", ({ params }) =>
      asUser(SourcesService, (sources, userId) =>
        sources.requestSourceDeletion(userId, params.vault_id, params.source_id),
      ),
    ),
);

const ProposalsHandlersLive = HttpApiBuilder.group(MountedGreatMindsApi, "proposals", (handlers) =>
  handlers
    .handle("listProposals", ({ params, query }) =>
      asUser(ProposalsService, (proposals, userId) =>
        proposals.list(userId, params.vault_id, query),
      ),
    )
    .handle("createProposal", ({ params, payload }) =>
      asUser(ProposalsService, (proposals, userId) =>
        proposals.create(userId, params.vault_id, payload),
      ),
    )
    .handle("getProposal", ({ params }) =>
      asUser(ProposalsService, (proposals, userId) =>
        proposals.get(userId, params.vault_id, params.proposal_id),
      ),
    )
    .handle("reviewProposal", ({ params, payload }) =>
      asUser(ProposalsService, (proposals, userId) =>
        proposals.review(userId, params.vault_id, params.proposal_id, payload),
      ),
    ),
);

const IngestHandlersLive = HttpApiBuilder.group(MountedGreatMindsApi, "ingest", (handlers) =>
  handlers
    .handle("ingestRaw", ({ params, payload }) =>
      asUser(IngestService, (ingest, userId) => ingest.ingestRaw(userId, params.vault_id, payload)),
    )
    .handle("promoteReference", ({ params, payload }) =>
      Effect.gen(function* () {
        const ingest = yield* IngestService;
        const current = yield* CurrentAuth;
        const result = yield* ingest.promoteReference(current.user_id, params.vault_id, payload);
        return result.created ? result.document : yield* jsonResponse(200, result.document);
      }),
    )
    .handle("ingestUserSuggestion", ({ params, payload }) =>
      asUser(IngestService, (ingest, userId) =>
        ingest.ingestUserSuggestion(userId, params.vault_id, payload),
      ),
    )
    .handle("checkFileIngestDupes", ({ params, payload }) =>
      Effect.gen(function* () {
        const batches = yield* FileIngestBatches;
        const current = yield* CurrentAuth;
        const existing = yield* batches.checkDupes(
          current.user_id,
          params.vault_id,
          payload.client_hashes,
        );
        return { existing: [...existing] };
      }),
    )
    .handle("createFileIngest", ({ params, payload }) =>
      asUser(FileIngestBatches, (batches, userId) =>
        batches.create(userId, params.vault_id, payload.batch_id, payload.files),
      ),
    )
    .handle("getFileIngest", ({ params }) =>
      asUser(FileIngestBatches, (batches, userId) => batches.get(userId, params.batch_id)),
    )
    .handle("resumeFileIngest", ({ params }) =>
      asUser(FileIngestBatches, (batches, userId) => batches.resume(userId, params.batch_id)),
    )
    .handle("uploadFileIngestFile", ({ params, payload }) =>
      asUser(FileIngestBatches, (batches, userId) =>
        batches.upload(userId, params.batch_id, params.hash, uploadedFileContent(payload)),
      ),
    )
    .handle("acknowledgeFileIngestUpload", ({ params }) =>
      asUser(FileIngestBatches, (batches, userId) =>
        batches.acknowledge(userId, params.batch_id, params.hash),
      ),
    )
    .handle("commitFileIngest", ({ params }) =>
      asUser(FileIngestBatches, (batches, userId) => batches.commit(userId, params.batch_id)),
    ),
);

const JobsHandlersLive = HttpApiBuilder.group(MountedGreatMindsApi, "jobs", (handlers) =>
  handlers
    .handle("startUrlJob", ({ params, payload }) =>
      Effect.gen(function* () {
        const urlIngest = yield* UrlIngestService;
        const current = yield* CurrentAuth;
        const canonicalUrl = yield* parseCanonicalSourceUrl(payload.url);
        return yield* urlIngest.start(current.user_id, params.vault_id, {
          jobId: payload.job_id,
          url: canonicalUrl,
          ...(payload.origin === undefined ? {} : { origin: payload.origin }),
        });
      }),
    )
    .handle("retryUrlJob", ({ params, payload }) =>
      asUser(UrlIngestService, (urlIngest, userId) =>
        urlIngest.retry(userId, params.vault_id, params.job_id, payload.job_id),
      ),
    )
    .handle("listJobs", ({ params, query }) =>
      asUser(JobsService, (jobs, userId) => jobs.list(userId, params.vault_id, query)),
    )
    .handle("getJob", ({ params }) =>
      asUser(JobsService, (jobs, userId) => jobs.get(userId, params.vault_id, params.job_id)),
    )
    .handle("streamJob", ({ params }) =>
      asUser(JobsService, (jobs, userId) => jobs.stream(userId, params.vault_id, params.job_id)),
    ),
);

const CompileHandlersLive = HttpApiBuilder.group(MountedGreatMindsApi, "compile", (handlers) =>
  handlers
    .handle("requestCompile", ({ params, payload }) =>
      Effect.gen(function* () {
        const current = yield* CurrentAuth;
        const access = yield* VaultAccessService;
        yield* access.requireOwner(current.user_id, params.vault_id);
        const config = yield* AppConfig;
        const missing = [
          config.extractModel,
          config.mapModel,
          config.reduceModel,
          config.renderModel,
          config.embeddingModel,
        ]
          .map((model) => missingModelKey(config, model))
          .find((key) => key !== undefined);
        if (missing !== undefined) {
          return yield* new ServiceUnavailable({ detail: notConfiguredDetail(missing) });
        }
        const jobs = yield* JobsService;
        return yield* jobs.requestCompile(current.user_id, params.vault_id, payload.job_id);
      }),
    )
    .handle("cancelCompile", ({ params }) =>
      asUser(JobsService, (jobs, userId) =>
        jobs.cancelCompile(userId, params.vault_id, params.run_id),
      ),
    ),
);

const LintHandlersLive = HttpApiBuilder.group(MountedGreatMindsApi, "lint", (handlers) =>
  handlers.handle("getLint", ({ params }) =>
    Effect.gen(function* () {
      const lint = yield* LintService;
      const current = yield* CurrentAuth;
      return yield* lint.report(current.user_id, params.vault_id);
    }),
  ),
);

const CostsHandlersLive = HttpApiBuilder.group(MountedGreatMindsApi, "costs", (handlers) =>
  handlers
    .handle("getUserCosts", ({ query }) =>
      asUser(CostsService, (costs, userId) => costs.forUser(userId, query)),
    )
    .handle("getVaultCosts", ({ params, query }) =>
      asUser(CostsService, (costs, userId) => costs.forVault(userId, params.vault_id, query)),
    ),
);

const DocumentsHandlersLive = HttpApiBuilder.group(MountedGreatMindsApi, "documents", (handlers) =>
  handlers
    .handle("resolveDocument", ({ params, query }) =>
      asUser(DocumentsService, (documents, userId) =>
        documents.readDocument(userId, params.vault_id, query.path),
      ),
    )
    .handle("searchVault", ({ params, query }) =>
      Effect.gen(function* () {
        const current = yield* CurrentAuth;
        const access = yield* VaultAccessService;
        yield* access.requireMember(current.user_id, params.vault_id);
        const queries = yield* QueryService;
        return yield* queries
          .search(current.user_id, params.vault_id, query.q, query.path)
          .pipe(
            Effect.catchTag("EmbeddingBatchFailed", (error) =>
              Effect.fail(
                new ServiceUnavailable({ detail: `Search is unavailable: ${error.message}` }),
              ),
            ),
          );
      }),
    )
    .handle("readChunks", ({ params, query }) =>
      asUser(DocumentsService, (documents, userId) =>
        documents.readChunks(userId, params.vault_id, query),
      ),
    )
    .handle("readLinks", ({ params, query }) =>
      asUser(DocumentsService, (documents, userId) =>
        documents.readLinks(userId, params.vault_id, query),
      ),
    ),
);

const SessionsHandlersLive = HttpApiBuilder.group(MountedGreatMindsApi, "sessions", (handlers) =>
  handlers
    .handle("continueAsSession", ({ params }) =>
      asUser(SessionsService, (sessions, userId) =>
        sessions.continueAsSession(userId, params.vault_id, params.session_id),
      ),
    )
    .handle("promoteSessionExchange", ({ params }) =>
      asUser(SessionsService, (sessions, userId) =>
        sessions.promoteExchange(userId, params.vault_id, params.session_id, params.exchange_id),
      ),
    )
    .handle("listSessions", ({ params, query }) =>
      asUser(SessionsService, (sessions, userId) =>
        sessions.listSessions(userId, params.vault_id, query),
      ),
    )
    .handle("listSessionsByOrigin", ({ params, query }) =>
      asUser(SessionsService, (sessions, userId) =>
        sessions.listSessionsByOrigin(userId, params.vault_id, query.doc_path),
      ),
    )
    .handle("readSession", ({ params }) =>
      asUser(SessionsService, (sessions, userId) =>
        sessions.readSession(userId, params.vault_id, params.session_id),
      ),
    )
    .handle("readSessionMarkdown", ({ params }) =>
      asUser(SessionExportsService, (exports, userId) =>
        exports.readMarkdown(userId, params.vault_id, params.session_id),
      ),
    )
    .handle("prepareSessionMarkdown", ({ params, payload }) =>
      asUser(SessionExportsService, (exports, userId) =>
        exports.readMarkdown(userId, params.vault_id, params.session_id, payload),
      ),
    )
    .handle("prepareSessionExport", ({ params, payload }) =>
      asUser(SessionExportsService, (exports, userId) =>
        exports.prepare(userId, params.vault_id, params.session_id, payload),
      ),
    ),
);

const RepliesHandlersLive = HttpApiBuilder.group(MountedGreatMindsApi, "replies", (handlers) =>
  handlers
    .handle("createReply", ({ params, payload }) =>
      asUser(RepliesService, (replies, userId) => replies.create(userId, params.vault_id, payload)),
    )
    .handle("retryReply", ({ params, payload }) =>
      asUser(RepliesService, (replies, userId) =>
        replies.retry(userId, params.vault_id, params.reply_id, payload.reply_id),
      ),
    )
    .handle("stopReply", ({ params }) =>
      asUser(RepliesService, (replies, userId) =>
        replies.stop(userId, params.vault_id, params.reply_id),
      ),
    )
    .handle("streamReply", ({ params }) =>
      asUser(RepliesService, (replies, userId) =>
        replies.stream(userId, params.vault_id, params.reply_id),
      ),
    ),
);

const SharesHandlersLive = HttpApiBuilder.group(MountedGreatMindsApi, "shares", (handlers) =>
  handlers
    .handle("createShare", ({ payload }) =>
      Effect.gen(function* () {
        const shares = yield* SharesService;
        const current = yield* CurrentAuth;
        return yield* shares.create(current.user_id, payload);
      }),
    )
    .handle("listShares", () => asUser(SharesService, (shares, userId) => shares.listMine(userId)))
    .handle("deleteShare", ({ params }) =>
      asUser(SharesService, (shares, userId) => shares.revoke(userId, params.share_id)),
    ),
);

const PublicHandlersLive = HttpApiBuilder.group(MountedGreatMindsApi, "public", (handlers) =>
  handlers.handle("resolveShare", ({ params }) =>
    Effect.gen(function* () {
      const shares = yield* SharesService;
      const detail = yield* shares.resolve(params.token);
      return HttpServerResponse.setHeaders(HttpServerResponse.jsonUnsafe(detail), {
        "X-Robots-Tag": "noindex",
        "Referrer-Policy": "no-referrer",
      });
    }),
  ),
);

const StreamHeadersLive = HttpRouter.middleware(
  (effect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const response = yield* effect;
      const pathname = new URL(request.url, "http://localhost").pathname;
      if (
        pathname.startsWith("/v1/vaults/") &&
        /\/sessions\/[^/]+\/(export|markdown)$/u.test(pathname)
      ) {
        return HttpServerResponse.setHeaders(response, {
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        });
      }
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

const invalidMultipart = () => new BadRequest({ detail: "Invalid multipart upload" });

const uploadedPartContent = (part: Multipart.Part) =>
  Multipart.isFile(part) && part.key === "file" && part.name.length > 0
    ? part.content.pipe(Stream.mapError(invalidMultipart))
    : Stream.fail(new BadRequest({ detail: "Uploaded file must have a filename" }));

const uploadedFileContent = (parts: Stream.Stream<Multipart.Part, Multipart.MultipartError>) =>
  parts.pipe(
    Stream.mapError(invalidMultipart),
    Stream.take(1),
    Stream.flatMap(uploadedPartContent),
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
  ApiLive,
  McpRoutesLive,
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

const formatUrl = (address: NetAddress.SocketAddress) =>
  NetAddress.formatUrlUnsafe(
    address._tag !== "UnixPathAddress" && NetAddress.isUnspecified(address.address)
      ? NetAddress.inetAddressUnsafe(
          address._tag === "InetAddressV4" ? NetAddress.ipv4Loopback : NetAddress.ipv6Loopback,
          address.port,
        )
      : address,
  );

export const openServer = (options: StartServerOptions = {}) =>
  Effect.gen(function* () {
    const services = yield* Layer.build(ServerLive(createServer(), options));
    return formatUrl(Context.get(services, HttpServer.HttpServer).address);
  });

export const startServer = async (options: StartServerOptions = {}): Promise<StartedServer> => {
  const nodeServer = createServer();
  const runtime = ManagedRuntime.make(ServerLive(nodeServer, options));
  try {
    const httpServer = await runtime.runPromise(HttpServer.HttpServer);
    return {
      server: nodeServer,
      runtime,
      url: formatUrl(httpServer.address),
      close: async () => {
        await runtime.dispose();
      },
    };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
};
