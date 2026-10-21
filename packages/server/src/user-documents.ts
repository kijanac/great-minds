import { randomUUID } from "node:crypto";
import { posix } from "node:path";

import { Database, userDocuments } from "@great-minds/database";
import {
  BadRequest,
  NotFound,
  type PageParams,
  type ReferenceDetail,
  type ReferenceDocumentResponse,
  type ReferenceOverview,
  type ReferencePage,
  type ReferenceUpdate,
  Uuid,
} from "@great-minds/domain";
import { and, desc, eq, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";

import { AppConfig } from "./config.ts";
import { bodyContentHash, fileContentHash } from "./crypto.ts";
import { fetchUrlMarkdown } from "./ingest.ts";
import { type CanonicalSourceUrl, slugify } from "./source-identity.ts";
import { buildDocument, parseFrontmatter } from "./markdown.ts";
import { oneTotal, pageEnvelope } from "./pagination.ts";
import { ContentStorage, userOwner } from "./storage.ts";

type UserDocumentRow = typeof userDocuments.$inferSelect;

type CreateReferenceResult = {
  readonly reference: ReferenceDetail;
  readonly created: boolean;
};

type UserDocumentsServiceShape = {
  readonly create: (
    userId: Uuid,
    url: CanonicalSourceUrl,
  ) => Effect.Effect<CreateReferenceResult, BadRequest>;
  readonly list: (userId: Uuid, params: PageParams) => Effect.Effect<ReferencePage>;
  readonly locate: (
    userId: Uuid,
    path: string,
  ) => Effect.Effect<UserDocumentRow, BadRequest | NotFound>;
  readonly loadText: (document: UserDocumentRow) => Effect.Effect<string, NotFound>;
  readonly readUserText: (
    userId: Uuid,
    path: string,
  ) => Effect.Effect<
    { readonly row: UserDocumentRow; readonly content: string },
    BadRequest | NotFound
  >;
  readonly read: (
    userId: Uuid,
    path: string,
  ) => Effect.Effect<ReferenceDocumentResponse, BadRequest | NotFound>;
  readonly delete: (userId: Uuid, referenceId: Uuid) => Effect.Effect<void, NotFound>;
  readonly update: (
    userId: Uuid,
    referenceId: Uuid,
    input: ReferenceUpdate,
  ) => Effect.Effect<ReferenceDetail, NotFound>;
};

export class UserDocumentsService extends Context.Service<
  UserDocumentsService,
  UserDocumentsServiceShape
>()("@great-minds/server/UserDocumentsService") {}

const referenceOverview = (row: UserDocumentRow): ReferenceOverview => ({
  id: row.id,
  file_path: row.filePath,
  title: row.title,
  url: row.url,
  origin: row.origin,
  author: row.author,
  published: row.published,
  created_at: row.createdAt,
  updated_at: row.updatedAt,
});

export const safeReferencePath = (path: string) => {
  if (path.includes("\\") || path.startsWith("/")) {
    return undefined;
  }
  if (path.split("/").includes("..")) {
    return undefined;
  }
  const normalized = posix.normalize(path);
  if (normalized === "." || !normalized.endsWith(".md")) {
    return undefined;
  }
  const parts = normalized.split("/");
  return parts[0] === "refs" && parts.length >= 2 ? normalized : undefined;
};

export const UserDocumentsServiceLive = Layer.effect(
  UserDocumentsService,
  Effect.gen(function* () {
    const db = yield* Database;
    const config = yield* AppConfig;
    const storage = yield* ContentStorage;

    const getByUrl = (userId: Uuid, url: string) =>
      db.query((d) => d
        .select()
        .from(userDocuments)
        .where(and(eq(userDocuments.userId, userId), eq(userDocuments.url, url)))
        .limit(1))
        .pipe(Effect.map((rows) => rows[0]));

    const getByPath = (userId: Uuid, filePath: string) =>
      db.query((d) => d
        .select()
        .from(userDocuments)
        .where(
          and(eq(userDocuments.userId, userId), eq(userDocuments.filePath, filePath)),
        )
        .limit(1))
        .pipe(Effect.map((rows) => rows[0]));

    const validatePath = (path: string) => {
      const safePath = safeReferencePath(path);
      return safePath === undefined
        ? Effect.fail(new BadRequest({ detail: `Invalid reference path: ${path}` }))
        : Effect.succeed(safePath);
    };

    const locate = (userId: Uuid, path: string) =>
      Effect.gen(function* () {
        const safePath = yield* validatePath(path);
        const row = yield* getByPath(userId, safePath);
        if (row === undefined)
          return yield* new NotFound({ detail: `Reference not found: ${safePath}` });
        return row;
      });

    const loadText = (document: UserDocumentRow) =>
      storage
        .readText(userOwner(document.userId), document.filePath)
        .pipe(
          Effect.mapError(
            () => new NotFound({ detail: `Reference not found: ${document.filePath}` }),
          ),
        );

    const readUserText = (userId: Uuid, path: string) =>
      Effect.gen(function* () {
        const row = yield* locate(userId, path);
        const content = yield* loadText(row);
        return { row, content };
      });

    return {
      create: (userId, canonicalUrl) =>
        Effect.gen(function* () {
          const existing = yield* getByUrl(userId, canonicalUrl);
          if (existing !== undefined) {
            return { reference: referenceOverview(existing), created: false };
          }

          const referenceId = Uuid.make(randomUUID(), { disableChecks: true });
          const fetched = yield* fetchUrlMarkdown(canonicalUrl, config.allowPrivateUrlFetch);
          const parsedUrl = new URL(fetched.url);
          const stem = posix.parse(parsedUrl.pathname).name || "doc";
          const slug = slugify(stem) || "doc";
          const filePath = `refs/${slug}-${referenceId}.md`;
          const origin = parsedUrl.host;
          const content = buildDocument(fetched.markdown, {
            sourceType: "document",
            url: fetched.url,
            origin,
          });
          const parsed = parseFrontmatter(content);
          yield* storage.writeText(userOwner(userId), filePath, content);
          const accepted = yield* db.transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.execute(
                sql`select pg_advisory_xact_lock(hashtextextended(${`reference-url:${userId}:${canonicalUrl}`}, 0))`,
              );
              const existing = yield* tx
                .select()
                .from(userDocuments)
                .where(and(eq(userDocuments.userId, userId), eq(userDocuments.url, canonicalUrl)))
                .limit(1);
              const prior = existing[0];
              if (prior !== undefined) return { row: prior, created: false };
              const rows = yield* tx
                .insert(userDocuments)
                .values({
                  id: referenceId,
                  userId,
                  filePath,
                  fileHash: fileContentHash(content),
                  bodyHash: bodyContentHash(parsed.body),
                  title: fetched.title,
                  url: fetched.url,
                  origin,
                  author: fetched.author,
                  published: fetched.published,
                })
                .returning();
              const row = rows[0];
              if (row === undefined) throw new Error("user document insert returned no row");
              return { row, created: true };
            }),
          );
          if (accepted.row.id !== referenceId)
            yield* storage.deletePath(userOwner(userId), filePath);
          return { reference: referenceOverview(accepted.row), created: accepted.created };
        }),
      list: (userId, params) =>
        Effect.gen(function* () {
          const countRows = yield* db.query((d) => d
            .select({ total: sql<number>`count(*)::int` })
            .from(userDocuments)
            .where(eq(userDocuments.userId, userId)));
          const rows = yield* db.query((d) => d
            .select()
            .from(userDocuments)
            .where(eq(userDocuments.userId, userId))
            .orderBy(desc(userDocuments.createdAt), desc(userDocuments.id))
            .limit(params.limit)
            .offset(params.offset));
          return pageEnvelope(rows.map(referenceOverview), params, oneTotal(countRows));
        }),
      locate,
      loadText,
      readUserText,
      read: (userId, path) =>
        Effect.gen(function* () {
          const { row, content } = yield* readUserText(userId, path);
          return {
            reference: referenceOverview(row),
            body: parseFrontmatter(content).body,
          };
        }),
      delete: (userId, referenceId) =>
        Effect.gen(function* () {
          const rows = yield* db.query((d) => d
            .delete(userDocuments)
            .where(and(eq(userDocuments.userId, userId), eq(userDocuments.id, referenceId)))
            .returning({ filePath: userDocuments.filePath }));
          const deleted = rows[0];
          if (deleted === undefined) {
            return yield* new NotFound({ detail: "Reference not found" });
          }
          yield* storage.deletePath(userOwner(userId), deleted.filePath);
        }),
      update: (userId, referenceId, input) =>
        Effect.gen(function* () {
          // Trim the incoming title; whitespace-only input clears it. The
          // stored markdown frontmatter does not carry the title, so only the
          // user_documents row is touched.
          const trimmed = input.title?.trim() ?? null;
          const title = trimmed === "" ? null : trimmed;
          const rows = yield* db.query((d) => d
            .update(userDocuments)
            .set({ title, updatedAt: sql`now()` })
            .where(and(eq(userDocuments.userId, userId), eq(userDocuments.id, referenceId)))
            .returning());
          const row = rows[0];
          if (row === undefined) {
            return yield* new NotFound({ detail: "Reference not found" });
          }
          return referenceOverview(row);
        }),
    } satisfies UserDocumentsServiceShape;
  }),
);
