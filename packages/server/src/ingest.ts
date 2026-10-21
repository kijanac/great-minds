import { randomUUID } from "node:crypto";
import { posix } from "node:path";

import { compileIntents, Database, pipelineRuns } from "@great-minds/database";
import {
  BadRequest,
  Conflict,
  Forbidden,
  type IngestedDocument,
  NotFound,
  type RawSource,
  type ReferencePromote,
  type SessionExchangeEvent,
  type SessionOrigin,
  type UserSuggestion,
  type UserSuggestionIntent,
  type UserSuggestionResult,
  Uuid,
} from "@great-minds/domain";
import { eq, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { AppConfig } from "./config.ts";
import { htmlToMarkdown, markdownWithTitle } from "./conversion.ts";
import { errorDetails } from "./error-details.ts";
import { buildDocument, sessionExchangeDocumentInput } from "./markdown.ts";
import { PipelineRunsService } from "./pipeline-runs.ts";
import { ProposalsService } from "./proposals.ts";
import { fetchAnyUrl, fetchPublicUrl, responseTextCapped } from "./public-fetch.ts";
import { scopedAbortSignal } from "./scoped-abort-signal.ts";
import {
  type CanonicalSourceUrl,
  identifySourceMarkdown,
  slugify,
  sourceIdForKey,
} from "./source-identity.ts";
import { type SourceAdmission, SourceDocumentsService } from "./source-documents.ts";
import { UserDocumentsService } from "./user-documents.ts";
import { VaultAccessService } from "./vaults.ts";
import { ClockService } from "./clock.ts";

type IngestServiceShape = {
  readonly ingestRaw: (
    userId: Uuid,
    vaultId: Uuid,
    input: RawSource,
  ) => Effect.Effect<IngestedDocument, Forbidden | Conflict>;
  readonly promoteReference: (
    userId: Uuid,
    vaultId: Uuid,
    input: ReferencePromote,
  ) => Effect.Effect<
    { readonly document: IngestedDocument; readonly created: boolean },
    BadRequest | Forbidden | NotFound | Conflict
  >;
  readonly ingestUserSuggestion: (
    userId: Uuid,
    vaultId: Uuid,
    input: UserSuggestion,
  ) => Effect.Effect<UserSuggestionResult, BadRequest | Forbidden | Conflict>;
  readonly ingestUrl: (
    source: SourceAdmission,
    canonicalUrl: CanonicalSourceUrl,
    origin: string | undefined,
    pipelineRunId: Uuid,
  ) => Effect.Effect<IngestedDocument, BadRequest | Conflict>;
  readonly ingestSessionExchange: (
    source: SourceAdmission,
    sessionId: string,
    exchange: SessionExchangeEvent,
    sessionOrigin: SessionOrigin | null,
  ) => Effect.Effect<IngestedDocument, Conflict>;
};

export class IngestService extends Context.Service<IngestService, IngestServiceShape>()(
  "@great-minds/server/IngestService",
) {}

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const urlResponseContentType = (contentTypeHeader: string | null) =>
  contentTypeHeader?.split(";", 1)[0]?.trim().toLowerCase() ?? "text/html";

const isSupportedUrlContentType = (contentType: string) =>
  contentType === "text/html" || contentType === "text/plain";

const MAX_URL_RESPONSE_BYTES = 25 * 1024 * 1024;

export const fetchUrlMarkdown = (url: CanonicalSourceUrl, allowPrivateUrlFetch: boolean) =>
  Effect.gen(function* () {
    const fetchUrl = allowPrivateUrlFetch ? fetchAnyUrl : fetchPublicUrl;
    const signal = yield* scopedAbortSignal;
    const response = yield* Effect.tryPromise({
      try: () =>
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
  }).pipe(Effect.scoped);

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

export const IngestServiceLive = Layer.effect(
  IngestService,
  Effect.gen(function* () {
    const db = yield* Database;
    const config = yield* AppConfig;
    const access = yield* VaultAccessService;
    const sourceDocumentsWrite = yield* SourceDocumentsService;
    const userDocumentsRead = yield* UserDocumentsService;
    const proposals = yield* ProposalsService;
    const pipeline = yield* PipelineRunsService;
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
        return intent.id;
      });

    const publishSource = (
      source: SourceAdmission,
      rendered: string,
      options: {
        readonly canonicalUrl?: CanonicalSourceUrl | null;
        readonly pipelineRunId?: Uuid | null;
      } = {},
    ) =>
      Effect.gen(function* () {
        const content = identifySourceMarkdown(rendered, source.id, options.canonicalUrl ?? null);
        const id = yield* sourceDocumentsWrite.write(source, content, null);
        yield* ensureCompileIntent(source.vaultId, options.pipelineRunId);
        return { id, file_path: source.filePath } satisfies IngestedDocument;
      });

    const ingestUrl = (
      source: SourceAdmission,
      canonicalUrl: CanonicalSourceUrl,
      origin: string | undefined,
      pipelineRunId: Uuid,
    ) =>
      Effect.gen(function* () {
        const fetched = yield* fetchUrlMarkdown(canonicalUrl, config.allowPrivateUrlFetch);
        if (!(yield* pipeline.isActive(pipelineRunId))) return yield* Effect.interrupt;
        const parsed = new URL(canonicalUrl);
        return yield* publishSource(
          source,
          buildDocument(markdownWithTitle(fetched.title, fetched.markdown), {
            sourceType: "document",
            url: canonicalUrl,
            origin: origin ?? parsed.host,
          }),
          { canonicalUrl, pipelineRunId },
        );
      });

    return {
      ingestRaw: (userId, vaultId, input) =>
        Effect.gen(function* () {
          yield* access.requireOwner(userId, vaultId);
          const sourceId = Uuid.make(randomUUID(), { disableChecks: true });
          const source = yield* sourceDocumentsWrite.admit(
            vaultId,
            sourceId,
            sourcePathWithId(input.dest, sourceId),
          );
          return yield* publishSource(
            source,
            buildDocument(input.content, {
              sourceType: "document",
              origin: input.origin,
            }),
          );
        }),
      promoteReference: (userId, vaultId, input) =>
        Effect.gen(function* () {
          yield* access.requireOwner(userId, vaultId);
          const reference = yield* userDocumentsRead.locate(userId, input.path);
          const sourceId = sourceIdForKey(vaultId, `reference:${reference.id}`);
          const existing = yield* sourceDocumentsWrite.getById(vaultId, sourceId);
          if (existing !== undefined) {
            return {
              document: { id: sourceId, file_path: existing.filePath },
              created: false,
            };
          }
          const parsed = posix.parse(posix.basename(reference.filePath));
          const dest = `raw/docs/${parsed.name}-${sourceId}${parsed.ext}`;
          const source = yield* sourceDocumentsWrite.admit(vaultId, sourceId, dest);
          const content = yield* userDocumentsRead.loadText(reference);
          const document = yield* publishSource(source, content);
          return { document, created: true };
        }),
      ingestUserSuggestion: (userId, vaultId, input) =>
        Effect.gen(function* () {
          const scope = yield* access.requireEditor(userId, vaultId);
          if (input.body.trim().length === 0) {
            return yield* new BadRequest({ detail: "body is empty" });
          }
          const now = yield* clock.now;
          const sourceId = Uuid.make(randomUUID(), { disableChecks: true });
          const dest = userSuggestionDest(now, input.intent, input.anchored_to, sourceId);
          const frontmatter = {
            sourceType: "user",
            origin: "user-suggestion",
            anchoredTo: input.anchored_to,
            anchoredSection: input.anchored_section,
            intent: input.intent,
          };
          if (scope.role === "owner") {
            const source = yield* sourceDocumentsWrite.admit(vaultId, sourceId, dest);
            const document = yield* publishSource(source, buildDocument(input.body, frontmatter));
            return { ...document, mode: "ingested" } satisfies UserSuggestionResult;
          }
          const source = yield* sourceDocumentsWrite.admit(vaultId, sourceId, dest);
          const rendered = identifySourceMarkdown(
            buildDocument(input.body, frontmatter),
            sourceId,
          );
          yield* proposals.createRendered(source, userId, {
            contentType: "user_suggestion",
            title: null,
            author: null,
            rendered,
          });
          return {
            id: sourceId,
            file_path: dest,
            mode: "proposed",
          } satisfies UserSuggestionResult;
        }),
      ingestUrl,
      ingestSessionExchange: (source, sessionId, exchange, sessionOrigin) =>
        publishSource(
          source,
          buildDocument(
            exchange.answer,
            sessionExchangeDocumentInput(sessionId, exchange, sessionOrigin),
          ),
        ),
    } satisfies IngestServiceShape;
  }),
);
