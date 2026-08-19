import { Database, sessions, shares, userDocuments } from "@great-minds/database";
import {
  NotFound,
  type ShareCreate,
  type ShareCreateResult,
  type ShareOverview,
  type ShareSubjectKind,
  type SharedAnnotation,
  type SharedShareDetail,
  type SessionExchangeEvent,
  type SessionId,
  SessionOrigin as SessionOriginSchema,
  type Uuid,
} from "@great-minds/domain";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { ClockService } from "./clock.ts";
import { StructuredLogger } from "./logging.ts";
import { parseFrontmatter, stripAnchors } from "./markdown.ts";
import { RandomBytesService, formatUuid7 } from "./random.ts";
import { SessionsService } from "./sessions.ts";
import { UserDocumentsService } from "./user-documents.ts";

type ShareRow = typeof shares.$inferSelect;

type SharesServiceShape = {
  readonly create: (userId: Uuid, input: ShareCreate) => Effect.Effect<ShareCreateResult, NotFound>;
  readonly listMine: (userId: Uuid) => Effect.Effect<readonly ShareOverview[]>;
  readonly revoke: (userId: Uuid, shareId: Uuid) => Effect.Effect<void, NotFound>;
  readonly resolve: (token: string) => Effect.Effect<SharedShareDetail, NotFound>;
};

export class SharesService extends Context.Service<SharesService, SharesServiceShape>()(
  "@great-minds/server/SharesService",
) {}

const shareOverview = (row: ShareRow): ShareOverview => ({
  id: row.id as Uuid,
  token: row.token,
  subject_kind: row.subjectKind as ShareSubjectKind,
  subject_id: row.subjectId as Uuid,
  created_by: row.createdBy as Uuid,
  include_annotations: row.includeAnnotations,
  created_at: row.createdAt.toISOString(),
  expires_at: row.expiresAt?.toISOString() ?? null,
  revoked_at: row.revokedAt?.toISOString() ?? null,
});

const decodeSessionOrigin = Schema.decodeUnknownSync(Schema.NullOr(SessionOriginSchema));

export const SharesServiceLive = Layer.effect(
  SharesService,
  Effect.gen(function* () {
    const db = yield* Database;
    const clock = yield* ClockService;
    const randomBytes = yield* RandomBytesService;
    const sessionsService = yield* SessionsService;
    const documents = yield* UserDocumentsService;
    const logger = yield* StructuredLogger;

    const getByToken = (token: string) =>
      db.query((d) => d
        .select()
        .from(shares)
        .where(eq(shares.token, token))
        .limit(1))
        .pipe(Effect.map((rows) => rows[0]));

    const mintToken = () =>
      Effect.gen(function* () {
        const bytes = yield* randomBytes.bytes(32);
        return Buffer.from(bytes).toString("base64url");
      });

    const findSessionByOwner = (userId: Uuid, sessionId: string) =>
      db.query((d) => d
        .select()
        .from(sessions)
        .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
        .limit(1))
        .pipe(Effect.map((rows) => rows[0]));

    const loadAnnotations = (userId: Uuid, filePath: string) =>
      Effect.gen(function* () {
        const rows = yield* db.query((d) => d
          .select()
          .from(sessions)
          .where(
            and(
              eq(sessions.userId, userId),
              sql`${sessions.origin}->>'doc_path' = ${filePath}`,
              sql`${sessions.origin}->>'origin_scope' = 'personal'`,
              sql`${sessions.origin}->>'anchor' IS NOT NULL`,
            ),
          )
          .orderBy(asc(sessions.createdAt)));
        const annotations: SharedAnnotation[] = [];
        for (const row of rows) {
          const origin = decodeSessionOrigin(row.origin);
          if (origin === null) {
            continue;
          }
          const events = yield* Effect.result(
            sessionsService.readSession(userId, row.vaultId as Uuid, row.id as SessionId),
          );
          if (events._tag === "Failure") {
            yield* logger.warn("share_annotation_skipped", {
              session_id: row.id,
              file_path: filePath,
              reason: "session_unreadable",
            });
            continue;
          }
          annotations.push({
            anchor: {
              quote: origin.anchor ?? "",
              context: origin.paragraph,
              block_offset: origin.paragraph_index,
            },
            exchanges: events.success.events
              .filter((event): event is SessionExchangeEvent => event.type === "exchange")
              .map((event) => ({ query: event.query, answer: event.answer ?? "" })),
            created_at: row.createdAt.toISOString(),
          });
        }
        return annotations;
      });

    return {
      create: (userId, input) =>
        Effect.gen(function* () {
          if (input.subject_kind === "session") {
            const session = yield* findSessionByOwner(userId, input.subject_id);
            if (session === undefined) {
              return yield* new NotFound({ detail: "Session not found" });
            }
            yield* sessionsService
              .readSession(userId, session.vaultId as Uuid, session.id as SessionId)
              .pipe(
                Effect.catchTag("Forbidden", () =>
                  Effect.fail(new NotFound({ detail: "Session not found" })),
                ),
              );
          } else {
            const rows = yield* db.query((d) => d
              .select()
              .from(userDocuments)
              .where(and(eq(userDocuments.id, input.subject_id), eq(userDocuments.userId, userId)))
              .limit(1))
              .pipe(Effect.orDie);
            if (rows[0] === undefined) {
              return yield* new NotFound({ detail: "Reference not found" });
            }
          }

          const now = yield* clock.now;
          const existing = yield* db.query((d) => d
            .select()
            .from(shares)
            .where(and(
              eq(shares.createdBy, userId),
              eq(shares.subjectKind, input.subject_kind),
              eq(shares.subjectId, input.subject_id),
              isNull(shares.revokedAt),
            ))
            .limit(1))
            .pipe(Effect.orDie);
          const existingRow = existing[0];
          if (existingRow !== undefined) {
            const includeAnnotations = input.include_annotations ?? true;
            if (existingRow.includeAnnotations !== includeAnnotations) {
              const updated = yield* db.query((d) => d
                .update(shares)
                .set({ includeAnnotations })
                .where(eq(shares.id, existingRow.id))
                .returning())
                .pipe(Effect.orDie);
              const updatedRow = updated[0];
              if (updatedRow === undefined) {
                throw new Error("share update returned no rows");
              }
              return { share: shareOverview(updatedRow), created: false };
            }
            return { share: shareOverview(existingRow), created: false };
          }

          const idBytes = yield* randomBytes.bytes(16);
          const token = yield* mintToken();
          const rows = yield* db.query((d) => d
            .insert(shares)
            .values({
              id: formatUuid7(now.getTime(), idBytes),
              token,
              subjectKind: input.subject_kind,
              subjectId: input.subject_id,
              createdBy: userId,
              includeAnnotations: input.include_annotations ?? true,
              expiresAt: input.expires_at === undefined ? null : new Date(input.expires_at),
            })
            .returning())
            .pipe(Effect.orDie);
          const row = rows[0];
          if (row === undefined) {
            throw new Error("share insert returned no rows");
          }
          return { share: shareOverview(row), created: true };
        }),
      listMine: (userId) =>
        db.query((d) => d
          .select()
          .from(shares)
          .where(eq(shares.createdBy, userId))
          .orderBy(desc(shares.createdAt)))
          .pipe(Effect.map((rows) => rows.map(shareOverview))),
      revoke: (userId, shareId) =>
        Effect.gen(function* () {
          const now = yield* clock.now;
          const rows = yield* db.query((d) => d
            .update(shares)
            .set({ revokedAt: now })
            .where(and(eq(shares.id, shareId), eq(shares.createdBy, userId)))
            .returning({ id: shares.id }))
            .pipe(Effect.orDie);
          if (rows[0] === undefined) {
            return yield* new NotFound({ detail: "Share not found" });
          }
        }),
      resolve: (token) =>
        Effect.gen(function* () {
          const row = yield* getByToken(token);
          const now = yield* clock.now;
          if (
            row === undefined ||
            row.revokedAt !== null ||
            (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime())
          ) {
            return yield* new NotFound({ detail: "Share not found" });
          }

          if (row.subjectKind === "session") {
            const session = yield* findSessionByOwner(row.createdBy as Uuid, row.subjectId);
            if (session === undefined) {
              return yield* new NotFound({ detail: "Share not found" });
            }
            const markdown = yield* sessionsService
              .readMarkdown(row.createdBy as Uuid, session.vaultId as Uuid, session.id as SessionId)
              .pipe(
                Effect.catchTag("Forbidden", () =>
                  Effect.fail(new NotFound({ detail: "Share not found" })),
                ),
              );
            return {
              subject_kind: "session" as const,
              title: session.query,
              markdown,
              created_at: session.createdAt.toISOString(),
            };
          }

          const rows = yield* db.query((d) => d
            .select()
            .from(userDocuments)
            .where(eq(userDocuments.id, row.subjectId))
            .limit(1))
            .pipe(Effect.orDie);
          const reference = rows[0];
          if (reference === undefined) {
            return yield* new NotFound({ detail: "Share not found" });
          }
          const { content } = yield* documents.readUserText(row.createdBy as Uuid, reference.filePath).pipe(
            Effect.catchTag("BadRequest", (error) => Effect.die(error)),
            Effect.catchTag("NotFound", () =>
              Effect.fail(new NotFound({ detail: "Share not found" })),
            ),
          );
          const body = parseFrontmatter(content).body;
          return {
            subject_kind: "reference" as const,
            title: reference.title,
            markdown: row.includeAnnotations ? body : stripAnchors(body),
            origin: reference.origin,
            author: reference.author,
            published: reference.published,
            annotations: row.includeAnnotations
              ? yield* loadAnnotations(row.createdBy as Uuid, reference.filePath)
              : [],
            created_at: reference.createdAt.toISOString(),
          };
        }),
    } satisfies SharesServiceShape;
  }),
);
