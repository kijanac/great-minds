import { Database, sessions, shares, userDocuments } from "@great-minds/database";
import {
  NotFound,
  ServiceUnavailable,
  type ShareCreate,
  type ShareOverview,
  type SharesQuery,
  type SharedAnnotation,
  type SharedShareDetail,
  SessionId,
  stripPassageMarkers,
  type Uuid,
} from "@great-minds/domain";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { ClockService } from "./clock.ts";
import { AppConfig } from "./config.ts";
import { StructuredLogger } from "./logging.ts";
import { parseFrontmatter } from "./markdown.ts";
import { sharedSessionPublication } from "./publication/markdown.ts";
import { RandomBytesService, formatUuid7 } from "./random.ts";
import { SessionsService } from "./sessions.ts";
import { UserDocumentsService } from "./user-documents.ts";

type ShareRow = typeof shares.$inferSelect;

type SharesServiceShape = {
  readonly create: (
    userId: Uuid,
    input: ShareCreate,
  ) => Effect.Effect<ShareOverview, NotFound | ServiceUnavailable>;
  readonly listMine: (userId: Uuid, query: SharesQuery) => Effect.Effect<readonly ShareOverview[]>;
  readonly revoke: (userId: Uuid, shareId: Uuid) => Effect.Effect<void, NotFound>;
  readonly resolve: (
    token: string,
  ) => Effect.Effect<SharedShareDetail, NotFound | ServiceUnavailable>;
};

export class SharesService extends Context.Service<SharesService, SharesServiceShape>()(
  "@great-minds/server/SharesService",
) {}

const shareOverview = (row: ShareRow): ShareOverview => ({
  id: row.id,
  token: row.token,
  subject_kind: row.subjectKind,
  subject_id: row.subjectId,
  created_by: row.createdBy,
  include_annotations: row.includeAnnotations,
  created_at: row.createdAt,
  revoked_at: row.revokedAt,
});

const sessionIdOf = Schema.decodeSync(SessionId);

export const SharesServiceLive = Layer.effect(
  SharesService,
  Effect.gen(function* () {
    const db = yield* Database;
    const clock = yield* ClockService;
    const randomBytes = yield* RandomBytesService;
    const sessionsService = yield* SessionsService;
    const documents = yield* UserDocumentsService;
    const logger = yield* StructuredLogger;
    const config = yield* AppConfig;

    const getByToken = (token: string) =>
      db
        .query((d) => d.select().from(shares).where(eq(shares.token, token)).limit(1))
        .pipe(Effect.map((rows) => rows[0]));

    const mintToken = () =>
      Effect.gen(function* () {
        const bytes = yield* randomBytes.bytes(32);
        return Buffer.from(bytes).toString("base64url");
      });

    const findSessionByOwner = (userId: Uuid, sessionId: SessionId) =>
      db
        .query((d) =>
          d
            .select()
            .from(sessions)
            .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
            .limit(1),
        )
        .pipe(Effect.map((rows) => rows[0]));

    const loadAnnotations = (userId: Uuid, filePath: string) =>
      Effect.gen(function* () {
        const rows = yield* db.query((d) =>
          d
            .select()
            .from(sessions)
            .where(
              and(
                eq(sessions.userId, userId),
                sql`${sessions.origin}->>'doc_path' = ${filePath}`,
                sql`${sessions.origin}->>'origin_scope' = 'personal'`,
                sql`${sessions.origin}->>'passage' IS NOT NULL`,
              ),
            )
            .orderBy(asc(sessions.createdAt)),
        );
        const annotations: SharedAnnotation[] = [];
        for (const row of rows) {
          const passage = row.origin?.passage ?? null;
          if (passage === null) continue;
          const events = yield* Effect.result(
            sessionsService.readPublication(userId, row.vaultId, row.id),
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
            passage,
            exchanges: events.success.map((event) => ({
              query: event.query,
              answer: event.answer,
            })),
            created_at: row.createdAt,
          });
        }
        return annotations;
      });

    return {
      create: (userId, input) =>
        Effect.gen(function* () {
          if (input.subject_kind === "session") {
            const session = yield* findSessionByOwner(userId, sessionIdOf(input.subject_id));
            if (session === undefined) {
              return yield* new NotFound({ detail: "Session not found" });
            }
            yield* sessionsService
              .readSession(userId, session.vaultId, session.id)
              .pipe(
                Effect.catchTag("Forbidden", () =>
                  Effect.fail(new NotFound({ detail: "Session not found" })),
                ),
              );
          } else {
            const rows = yield* db.query((d) =>
              d
                .select()
                .from(userDocuments)
                .where(
                  and(eq(userDocuments.id, input.subject_id), eq(userDocuments.userId, userId)),
                )
                .limit(1),
            );
            if (rows[0] === undefined) {
              return yield* new NotFound({ detail: "Reference not found" });
            }
          }

          const now = yield* clock.now;
          const idBytes = yield* randomBytes.bytes(16);
          const token = yield* mintToken();
          const includeAnnotations = input.include_annotations ?? true;
          const [row] = yield* db.query((d) =>
            d
              .insert(shares)
              .values({
                id: formatUuid7(now.getTime(), idBytes),
                token,
                subjectKind: input.subject_kind,
                subjectId: input.subject_id,
                createdBy: userId,
                includeAnnotations,
              })
              .onConflictDoUpdate({
                target: [shares.createdBy, shares.subjectKind, shares.subjectId],
                targetWhere: sql`${shares.revokedAt} IS NULL`,
                set: { includeAnnotations },
              })
              .returning(),
          );
          if (row === undefined)
            return yield* Effect.die(new Error("share upsert returned no rows"));
          return shareOverview(row);
        }),
      listMine: (userId, query) =>
        db
          .query((d) =>
            d
              .select()
              .from(shares)
              .where(
                and(
                  eq(shares.createdBy, userId),
                  query.subject_kind === undefined
                    ? undefined
                    : eq(shares.subjectKind, query.subject_kind),
                  query.subject_id === undefined
                    ? undefined
                    : eq(shares.subjectId, query.subject_id),
                ),
              )
              .orderBy(desc(shares.createdAt)),
          )
          .pipe(Effect.map((rows) => rows.map(shareOverview))),
      revoke: (userId, shareId) =>
        Effect.gen(function* () {
          const now = yield* clock.now;
          const rows = yield* db.query((d) =>
            d
              .update(shares)
              .set({ revokedAt: now })
              .where(and(eq(shares.id, shareId), eq(shares.createdBy, userId)))
              .returning({ id: shares.id }),
          );
          if (rows[0] === undefined) {
            return yield* new NotFound({ detail: "Share not found" });
          }
        }),
      resolve: (token) =>
        Effect.gen(function* () {
          const row = yield* getByToken(token);
          if (row === undefined || row.revokedAt !== null) {
            return yield* new NotFound({ detail: "Share not found" });
          }

          if (row.subjectKind === "session") {
            const session = yield* findSessionByOwner(row.createdBy, sessionIdOf(row.subjectId));
            if (session === undefined) {
              return yield* new NotFound({ detail: "Share not found" });
            }
            const shared = yield* sessionsService
              .readSession(row.createdBy, session.vaultId, session.id)
              .pipe(
                Effect.catchTag("Forbidden", () =>
                  Effect.fail(new NotFound({ detail: "Share not found" })),
                ),
              );
            return {
              subject_kind: "session" as const,
              title: session.query,
              markdown: sharedSessionPublication(shared, {
                webUrl: config.publicWebUrl,
                vaultId: session.vaultId,
              }).markdown,
              created_at: session.createdAt,
            };
          }

          const rows = yield* db.query((d) =>
            d.select().from(userDocuments).where(eq(userDocuments.id, row.subjectId)).limit(1),
          );
          const reference = rows[0];
          if (reference === undefined) {
            return yield* new NotFound({ detail: "Share not found" });
          }
          const { content } = yield* documents.readUserText(row.createdBy, reference.filePath).pipe(
            Effect.catchTag("BadRequest", (error) => Effect.die(error)),
            Effect.catchTag("NotFound", () =>
              Effect.fail(new NotFound({ detail: "Share not found" })),
            ),
          );
          const body = parseFrontmatter(content).body;
          return {
            subject_kind: "reference" as const,
            title: reference.title,
            markdown: row.includeAnnotations ? body : stripPassageMarkers(body),
            origin: reference.origin,
            author: reference.author,
            published: reference.published,
            annotations: row.includeAnnotations
              ? yield* loadAnnotations(row.createdBy, reference.filePath)
              : [],
            created_at: reference.createdAt,
          };
        }),
    } satisfies SharesServiceShape;
  }),
);
