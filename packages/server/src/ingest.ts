import { randomUUID } from "node:crypto";
import { posix } from "node:path";

import { compileIntents, Database, pipelineRuns } from "@great-minds/database";
import {
  BadRequest,
  Forbidden,
  type IngestedDocument,
  type JobResponse,
  NotFound,
  type RawSource,
  type ReferencePromote,
  type SessionExchangeEvent,
  type SessionOrigin,
  type UserSuggestion,
  type UserSuggestionIntent,
  type Uuid,
} from "@great-minds/domain";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Cause, Context, Effect, Layer } from "effect";
import { AppConfig } from "./config.ts";
import { htmlToMarkdown, markdownWithTitle } from "./conversion.ts";
import { causeDetails, errorDetails, formatError } from "./error-details.ts";
import { jobResponse } from "./job-response.ts";
import { buildDocument, sessionExchangeDocumentInput, sessionExchangePath } from "./markdown.ts";
import { progressSteps, type PipelineProgressStep } from "./pipeline-runs.ts";
import { ProposalsService } from "./proposals.ts";
import { fetchAnyUrl, fetchPublicUrl, responseTextCapped } from "./public-fetch.ts";
import {
  type CanonicalSourceUrl,
  identifySourceMarkdown,
  sourceIdForKey,
} from "./source-identity.ts";
import { SourceDocumentsService } from "./source-documents.ts";
import { ContentStorage, vaultOwner } from "./storage.ts";
import { UserDocumentsService } from "./user-documents.ts";
import { VaultAccessService } from "./vaults.ts";
import { ClockService } from "./clock.ts";

type IngestServiceShape = {
  readonly ingestRaw: (
    userId: Uuid,
    vaultId: Uuid,
    input: RawSource,
  ) => Effect.Effect<IngestedDocument, Forbidden>;
  readonly promoteReference: (
    userId: Uuid,
    vaultId: Uuid,
    input: ReferencePromote,
  ) => Effect.Effect<
    { readonly document: IngestedDocument; readonly created: boolean },
    BadRequest | Forbidden | NotFound
  >;
  readonly ingestUserSuggestion: (
    userId: Uuid,
    vaultId: Uuid,
    input: UserSuggestion,
  ) => Effect.Effect<IngestedDocument, BadRequest | Forbidden>;
  readonly startUrlJob: (
    userId: Uuid,
    vaultId: Uuid,
    input: { readonly job_id: Uuid; readonly url: CanonicalSourceUrl; readonly origin?: string },
  ) => Effect.Effect<JobResponse, BadRequest | Forbidden>;
  readonly ingestSessionExchange: (
    vaultId: Uuid,
    sessionId: string,
    exchange: SessionExchangeEvent,
    sessionOrigin: SessionOrigin | null,
  ) => Effect.Effect<IngestedDocument>;
};

export class IngestService extends Context.Service<IngestService, IngestServiceShape>()(
  "@great-minds/server/IngestService",
) {}

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const URL_INGEST_STEP_LABELS = {
  fetch_url: "Fetching source URL",
  convert_document: "Converting source document",
  index_document: "Indexing source document",
} as const;

export const slugify = (text: string, maxLen = 80) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen);

const urlResponseContentType = (contentTypeHeader: string | null) =>
  contentTypeHeader?.split(";", 1)[0]?.trim().toLowerCase() ?? "text/html";

const isSupportedUrlContentType = (contentType: string) =>
  contentType === "text/html" || contentType === "text/plain";

const MAX_URL_RESPONSE_BYTES = 25 * 1024 * 1024;

export const fetchUrlMarkdown = (url: CanonicalSourceUrl, allowPrivateUrlFetch: boolean) =>
  Effect.gen(function* () {
    const fetchUrl = allowPrivateUrlFetch ? fetchAnyUrl : fetchPublicUrl;
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetchUrl(url, {
          redirect: "follow",
          signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
          headers: { "User-Agent": USER_AGENT },
        }),
      catch: (error) =>
        new BadRequest({ detail: `Failed to fetch URL: ${errorDetails(error).message}` }),
    });
    if (!response.ok) {
      return yield* new BadRequest({
        detail: `Failed to fetch URL: HTTP ${response.status} ${response.statusText}`,
      });
    }
    const contentType = urlResponseContentType(response.headers.get("content-type"));
    if (!isSupportedUrlContentType(contentType)) {
      return yield* new BadRequest({
        detail: `Unsupported URL content-type: ${contentType}`,
      });
    }
    const body = yield* Effect.tryPromise({
      try: () => responseTextCapped(response, MAX_URL_RESPONSE_BYTES),
      catch: (error) =>
        new BadRequest({ detail: `Failed to fetch URL: ${errorDetails(error).message}` }),
    });
    if (contentType === "text/plain") {
      return { url, title: null, markdown: body, author: null, published: null };
    }
    const converted = yield* Effect.promise(() => htmlToMarkdown(body, url));
    return { url, ...converted };
  });

const utcTimestamp = (date: Date) =>
  date
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(/\.\d{3}Z$/, "Z");

const userSuggestionDest = (
  now: Date,
  intent: UserSuggestionIntent,
  anchoredTo: string,
  sourceId: Uuid,
) => {
  const anchorSlug = anchoredTo.length > 0 ? slugify(anchoredTo) || "general" : "general";
  return `raw/user/${utcTimestamp(now)}-${anchorSlug}-${intent}-${sourceId}.md`;
};

const sourcePathWithId = (filePath: string, sourceId: Uuid) => {
  const parsed = posix.parse(filePath);
  return posix.join(parsed.dir, `${parsed.name}-${sourceId}.md`);
};

const firstFailure = (cause: Cause.Cause<unknown>) => cause.reasons.find(Cause.isFailReason)?.error;

const causeMessage = (cause: Cause.Cause<unknown>) => {
  const failure = firstFailure(cause);
  if (failure instanceof BadRequest) {
    return failure.detail;
  }
  return formatError(causeDetails(cause));
};

export const IngestServiceLive = Layer.effect(
  IngestService,
  Effect.gen(function* () {
    const db = yield* Database;
    const config = yield* AppConfig;
    const access = yield* VaultAccessService;
    const storage = yield* ContentStorage;
    const sourceDocumentsWrite = yield* SourceDocumentsService;
    const userDocumentsRead = yield* UserDocumentsService;
    const proposals = yield* ProposalsService;
    const clock = yield* ClockService;

    const ensureCompileIntent = (vaultId: Uuid, pipelineRunId?: Uuid | null) =>
      Effect.gen(function* () {
        const rows = yield* db.query((d) => d
          .insert(compileIntents)
          .values({ vaultId, pipelineRunId: pipelineRunId ?? undefined })
          .onConflictDoUpdate({
            target: compileIntents.vaultId,
            targetWhere: sql`${compileIntents.dispatchedAt} IS NULL`,
            set: { vaultId: sql`compile_intents.vault_id` },
          })
          .returning({ id: compileIntents.id, pipelineRunId: compileIntents.pipelineRunId }));
        const intent = rows[0];
        if (intent === undefined) {
          throw new Error("compile intent upsert returned no row");
        }
        if (pipelineRunId !== undefined && pipelineRunId !== null) {
          if (intent.pipelineRunId === null) {
            yield* db.query((d) => d
              .update(compileIntents)
              .set({ pipelineRunId })
              .where(eq(compileIntents.id, intent.id)));
          }
          yield* db.query((d) => d
            .update(pipelineRuns)
            .set({ compileIntentId: intent.id, updatedAt: sql`now()` })
            .where(eq(pipelineRuns.id, pipelineRunId)));
        }
        return intent.id as Uuid;
      });

    const writeAndIndex = (
      vaultId: Uuid,
      sourceId: Uuid,
      rendered: string,
      dest: string,
      options: {
        readonly canonicalUrl?: CanonicalSourceUrl | null;
        readonly pipelineRunId?: Uuid | null;
      } = {},
    ) =>
      Effect.gen(function* () {
        const content = identifySourceMarkdown(
          rendered,
          sourceId,
          options.canonicalUrl ?? null,
        );
        yield* storage.writeText(vaultOwner(vaultId), dest, content);
        yield* sourceDocumentsWrite.index(vaultId, dest, content, null);
        yield* ensureCompileIntent(vaultId, options.pipelineRunId);
        return { id: sourceId, file_path: dest } satisfies IngestedDocument;
      });

    const ingestUrl = (
      vaultId: Uuid,
      canonicalUrl: CanonicalSourceUrl,
      origin?: string,
      pipelineRunId?: Uuid,
    ) =>
      Effect.gen(function* () {
        const fetched = yield* fetchUrlMarkdown(canonicalUrl, config.allowPrivateUrlFetch);
        const parsed = new URL(canonicalUrl);
        const sourceId = sourceIdForKey(vaultId, `url:${canonicalUrl}`);
        const stem = slugify(posix.parse(parsed.pathname).name || "doc") || "doc";
        const dest = `raw/docs/${stem}-${sourceId}.md`;
        return yield* writeAndIndex(
          vaultId,
          sourceId,
          buildDocument(markdownWithTitle(fetched.title, fetched.markdown), {
            sourceType: "document",
            url: canonicalUrl,
            origin: origin ?? parsed.host,
          }),
          dest,
          { canonicalUrl, pipelineRunId },
        );
      });

    const createPipelineRun = (jobId: Uuid, vaultId: Uuid, trigger: "url") =>
      Effect.gen(function* () {
        const inserted = yield* db.query((d) => d
          .insert(pipelineRuns)
          .values({
            id: jobId,
            vaultId,
            trigger,
            status: "pending",
            currentPhase: "",
            phaseStatus: "",
            progressSteps: [],
          })
          .onConflictDoNothing({ target: pipelineRuns.id })
          .returning());
        const row =
          inserted[0] ??
          (yield* db.query((d) => d
            .select()
            .from(pipelineRuns)
            .where(and(eq(pipelineRuns.id, jobId), eq(pipelineRuns.vaultId, vaultId)))
            .limit(1)))[0];
        if (row === undefined) {
          throw new Error(`Pipeline run missing after create: ${jobId}`);
        }
        return row;
      });

    const getPipelineRun = (jobId: Uuid, vaultId: Uuid) =>
      Effect.gen(function* () {
        const rows = yield* db.query((d) => d
          .select()
          .from(pipelineRuns)
          .where(and(eq(pipelineRuns.id, jobId), eq(pipelineRuns.vaultId, vaultId)))
          .limit(1));
        const row = rows[0];
        if (row === undefined) {
          throw new Error(`Pipeline run not found after creation: ${jobId}`);
        }
        return row;
      });

    const updateProgress = (
      jobId: Uuid,
      phase: string,
      phaseStatus: string,
      steps: readonly PipelineProgressStep[],
      error?: string,
    ) =>
      db.query((d) => d
        .update(pipelineRuns)
        .set({
          currentPhase: phase,
          phaseStatus,
          progressSteps: [...steps],
          status: phaseStatus === "failed" ? "failed" : "running",
          error,
          completedAt: phaseStatus === "failed" ? sql`now()` : undefined,
          updatedAt: sql`now()`,
        })
        // Terminal states, including cancelled, are never overwritten by progress.
        .where(
          and(eq(pipelineRuns.id, jobId), inArray(pipelineRuns.status, ["pending", "running"])),
        ));

    return {
      ingestRaw: (userId, vaultId, input) =>
        Effect.gen(function* () {
          yield* access.requireOwner(userId, vaultId);
          const sourceId = randomUUID() as Uuid;
          return yield* writeAndIndex(
            vaultId,
            sourceId,
            buildDocument(input.content, {
              sourceType: "document",
              origin: input.origin,
            }),
            sourcePathWithId(input.dest, sourceId),
          );
        }),
      promoteReference: (userId, vaultId, input) =>
        Effect.gen(function* () {
          yield* access.requireOwner(userId, vaultId);
          const reference = yield* userDocumentsRead.readUserText(userId, input.path);
          const sourceId = sourceIdForKey(vaultId, `reference:${reference.row.id}`);
          const existing = yield* sourceDocumentsWrite.getById(vaultId, sourceId);
          if (existing !== undefined) {
            return {
              document: { id: sourceId, file_path: existing.filePath },
              created: false,
            };
          }
          const parsed = posix.parse(posix.basename(reference.row.filePath));
          const dest = `raw/docs/${parsed.name}-${sourceId}${parsed.ext}`;
          const document = yield* writeAndIndex(
            vaultId,
            sourceId,
            reference.content,
            dest,
          );
          return { document, created: true };
        }),
      ingestUserSuggestion: (userId, vaultId, input) =>
        Effect.gen(function* () {
          const scope = yield* access.requireEditor(userId, vaultId);
          if (input.body.trim().length === 0) {
            return yield* new BadRequest({ detail: "body is empty" });
          }
          const now = yield* clock.now;
          const sourceId = randomUUID() as Uuid;
          const dest = userSuggestionDest(now, input.intent, input.anchored_to, sourceId);
          const frontmatter = {
            sourceType: "user",
            origin: "user-suggestion",
            anchoredTo: input.anchored_to,
            anchoredSection: input.anchored_section,
            intent: input.intent,
          };
          if (scope.role === "owner") {
            return yield* writeAndIndex(
              vaultId,
              sourceId,
              buildDocument(input.body, frontmatter),
              dest,
            );
          }
          const rendered = identifySourceMarkdown(
            buildDocument(input.body, frontmatter),
            sourceId,
          );
          yield* proposals.createRendered(vaultId, userId, {
            sourceId,
            contentType: "user_suggestion",
            title: null,
            author: null,
            destPath: dest,
            rendered,
          });
          return { id: sourceId, file_path: dest } satisfies IngestedDocument;
        }),
      startUrlJob: (userId, vaultId, input) =>
        Effect.gen(function* () {
          yield* access.requireOwner(userId, vaultId);
          const run = yield* createPipelineRun(input.job_id, vaultId, "url");
          yield* updateProgress(
            run.id as Uuid,
            "source_ingest",
            "started",
            progressSteps(URL_INGEST_STEP_LABELS, "fetch_url", {
              counts: { fetch_url: [0, 1] },
            }),
          );
          yield* Effect.matchCauseEffect(
            ingestUrl(vaultId, input.url, input.origin, run.id as Uuid),
            {
              onSuccess: Effect.succeed,
              onFailure: (cause) =>
                Effect.gen(function* () {
                  const message = causeMessage(cause);
                  yield* updateProgress(
                    run.id as Uuid,
                    "source_ingest",
                    "failed",
                    progressSteps(URL_INGEST_STEP_LABELS, "fetch_url", {
                      failed: new Set(["fetch_url"]),
                      details: { fetch_url: message },
                    }),
                    message,
                  );
                  const failure = firstFailure(cause);
                  if (failure instanceof BadRequest) {
                    return yield* failure;
                  }
                  return yield* Effect.failCause(cause);
                }),
            },
          );
          yield* updateProgress(
            run.id as Uuid,
            "source_ingest",
            "completed",
            progressSteps(URL_INGEST_STEP_LABELS, "index_document", {
              completed: new Set(Object.keys(URL_INGEST_STEP_LABELS)),
              counts: { fetch_url: [1, 1] },
            }),
          );
          const refreshed = yield* getPipelineRun(run.id as Uuid, vaultId);
          return jobResponse(refreshed);
        }),
      ingestSessionExchange: (vaultId, sessionId, exchange, sessionOrigin) => {
        const sourceId = sourceIdForKey(
          vaultId,
          `session:${sessionId}:${exchange.exId}`,
        );
        return writeAndIndex(
          vaultId,
          sourceId,
          buildDocument(
            exchange.answer ?? "",
            sessionExchangeDocumentInput(sessionId, exchange, sessionOrigin),
          ),
          sessionExchangePath(exchange.exId, sourceId),
        );
      },
    } satisfies IngestServiceShape;
  }),
);
