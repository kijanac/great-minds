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
  type Uuid,
} from "@great-minds/domain";
import { and, desc, eq, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";

import { AppConfig } from "./config.ts";
import { bodyContentHash, fileContentHash, sha256Hex } from "./crypto.ts";
import { fetchUrlMarkdown, normalizeUrl, slugify } from "./ingest.ts";
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
    url: string,
  ) => Effect.Effect<CreateReferenceResult, BadRequest>;
  readonly list: (userId: Uuid, params: PageParams) => Effect.Effect<ReferencePage>;
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
  readonly delete: (
    userId: Uuid,
    path: string,
  ) => Effect.Effect<void, BadRequest | NotFound>;
  readonly update: (
    userId: Uuid,
    path: string,
    input: ReferenceUpdate,
  ) => Effect.Effect<ReferenceDetail, BadRequest | NotFound>;
};

export class UserDocumentsService extends Context.Service<
  UserDocumentsService,
  UserDocumentsServiceShape
>()("@great-minds/server/UserDocumentsService") {}

const referenceOverview = (row: UserDocumentRow): ReferenceOverview => ({
  id: row.id as Uuid,
  file_path: row.filePath,
  title: row.title,
  url: row.url,
  origin: row.origin,
  author: row.author,
  published: row.published,
  created_at: row.createdAt.toISOString(),
  updated_at: row.updatedAt.toISOString(),
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

    const readUserText = (userId: Uuid, path: string) =>
      Effect.gen(function* () {
        const safePath = yield* validatePath(path);
        const row = yield* getByPath(userId, safePath);
        if (row === undefined) {
          return yield* new NotFound({ detail: `Reference not found: ${safePath}` });
        }
        const content = yield* Effect.result(storage.readText(userOwner(userId), safePath));
        if (content._tag === "Failure") {
          return yield* new NotFound({ detail: `Reference not found: ${safePath}` });
        }
        return { row, content: content.success };
      });

    return {
      create: (userId, rawUrl) =>
        Effect.gen(function* () {
          const normalizedUrl = normalizeUrl(rawUrl);
          const existing = yield* getByUrl(userId, normalizedUrl);
          if (existing !== undefined) {
            return { reference: referenceOverview(existing), created: false };
          }

          const fetched = yield* fetchUrlMarkdown(normalizedUrl, config.allowPrivateUrlFetch);
          const parsedUrl = new URL(fetched.url);
          const stem = posix.parse(parsedUrl.pathname).name || "doc";
          const slug = slugify(stem) || "doc";
          let filePath = `refs/${slug}.md`;
          const collision = yield* getByPath(userId, filePath);
          if (collision !== undefined && collision.url !== fetched.url) {
            filePath = `refs/${slug}-${sha256Hex(fetched.url).slice(0, 8)}.md`;
          }
          const origin = parsedUrl.host;
          const content = buildDocument(fetched.markdown, {
            sourceType: "document",
            url: fetched.url,
            origin,
          });
          const parsed = parseFrontmatter(content);
          yield* storage.writeText(userOwner(userId), filePath, content);
          const rows = yield* db.query((d) => d
            .insert(userDocuments)
            .values({
              id: randomUUID(),
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
            .onConflictDoUpdate({
              target: [userDocuments.userId, userDocuments.filePath],
              set: {
                fileHash: sql`excluded.file_hash`,
                bodyHash: sql`excluded.body_hash`,
                title: sql`excluded.title`,
                url: sql`excluded.url`,
                origin: sql`excluded.origin`,
                author: sql`excluded.author`,
                published: sql`excluded.published`,
                updatedAt: sql`now()`,
              },
            })
            .returning());
          const row = rows[0];
          if (row === undefined) {
            throw new Error("user document upsert returned no row");
          }
          return { reference: referenceOverview(row), created: true };
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
      readUserText,
      read: (userId, path) =>
        Effect.gen(function* () {
          const { row, content } = yield* readUserText(userId, path);
          return {
            reference: referenceOverview(row),
            body: parseFrontmatter(content).body,
          };
        }),
      delete: (userId, path) =>
        Effect.gen(function* () {
          const safePath = yield* validatePath(path);
          const rows = yield* db.query((d) => d
            .delete(userDocuments)
            .where(
              and(eq(userDocuments.userId, userId), eq(userDocuments.filePath, safePath)),
            )
            .returning({ id: userDocuments.id }));
          if (rows[0] === undefined) {
            return yield* new NotFound({ detail: `Reference not found: ${safePath}` });
          }
          yield* storage.deletePath(userOwner(userId), safePath);
        }),
      update: (userId, path, input) =>
        Effect.gen(function* () {
          const safePath = yield* validatePath(path);
          // Trim the incoming title; whitespace-only input clears it. The
          // stored markdown frontmatter does not carry the title, so only the
          // user_documents row is touched.
          const trimmed = input.title?.trim() ?? null;
          const title = trimmed === "" ? null : trimmed;
          const rows = yield* db.query((d) => d
            .update(userDocuments)
            .set({ title, updatedAt: sql`now()` })
            .where(
              and(eq(userDocuments.userId, userId), eq(userDocuments.filePath, safePath)),
            )
            .returning());
          const row = rows[0];
          if (row === undefined) {
            return yield* new NotFound({ detail: `Reference not found: ${safePath}` });
          }
          return referenceOverview(row);
        }),
    } satisfies UserDocumentsServiceShape;
  }),
);
