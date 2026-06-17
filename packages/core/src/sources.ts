import { createHash } from "node:crypto";
import path from "node:path";
import { Context, Data, Effect, Layer } from "effect";
import { and, asc, count, desc, eq, ilike, or, type SQL } from "drizzle-orm";
import { Db, type DbSession } from "@great-minds/db/context";
import { sourceDocuments, vaultMemberships, vaults } from "@great-minds/db/schema";
import { VaultInternalSchema, type VaultId } from "@great-minds/domain/vault";
import {
  SourceDocumentDeleteSchema,
  SourceDocumentPageSchema,
  SourceDocumentSchema,
  type SourceDocument,
  type SourceDocumentCreate,
  type SourceDocumentDelete,
  type SourceDocumentPage,
  type SourceListQuery,
} from "@great-minds/domain/source";
import { firstOrDie, firstOrFail } from "./effect-helpers.js";
import { StorageOperationFailed, VaultStorage } from "./storage.js";
import { VaultForbidden } from "./vaults.js";
import { loadWorkspace, VaultUnavailable, type VaultScope } from "./workspace.js";

export class SourceDocumentUnavailable extends Data.TaggedError("SourceDocumentUnavailable")<{
  message: string;
}> {}

export class SourceService extends Context.Service<
  SourceService,
  {
    readonly listSources: (
      scope: VaultScope,
      query: SourceListQuery,
    ) => Effect.Effect<SourceDocumentPage, VaultUnavailable>;
    readonly createSourceDocument: (
      scope: VaultScope,
      input: SourceDocumentCreate,
    ) => Effect.Effect<SourceDocument, StorageOperationFailed | VaultUnavailable>;
    readonly deleteSourceDocument: (
      scope: VaultScope,
      input: SourceDocumentDelete,
    ) => Effect.Effect<
      void,
      SourceDocumentUnavailable | StorageOperationFailed | VaultForbidden | VaultUnavailable
    >;
  }
>()("SourceService") {}

export const sourceServiceLayer = Layer.effect(
  SourceService,
  Effect.gen(function* () {
    const db = yield* Db;
    const storage = yield* VaultStorage;

    return SourceService.of({
      listSources: (scope, query) => listSources(scope, query).pipe(Effect.provideService(Db, db)),
      createSourceDocument: (scope, input) =>
        createSourceDocument(scope, input).pipe(
          Effect.provideService(Db, db),
          Effect.provideService(VaultStorage, storage),
        ),
      deleteSourceDocument: (scope, input) =>
        deleteSourceDocument(scope, input).pipe(
          Effect.provideService(Db, db),
          Effect.provideService(VaultStorage, storage),
        ),
    });
  }),
);

function listSources(
  scope: VaultScope,
  query: SourceListQuery,
): Effect.Effect<SourceDocumentPage, VaultUnavailable, Db> {
  return Effect.gen(function* () {
    const db = yield* Db;
    yield* loadWorkspace(scope);
    const where = sourceFilter(scope.vaultId, query);

    const rows = yield* db
      .select({
        filePath: sourceDocuments.filePath,
        sourceType: sourceDocuments.sourceType,
        title: sourceDocuments.title,
        author: sourceDocuments.author,
        publishedDate: sourceDocuments.publishedDate,
        url: sourceDocuments.url,
        origin: sourceDocuments.origin,
        genre: sourceDocuments.genre,
        precis: sourceDocuments.precis,
        tags: sourceDocuments.tags,
        derivedExtras: sourceDocuments.derivedExtras,
        updatedAt: sourceDocuments.updatedAt,
      })
      .from(sourceDocuments)
      .where(where)
      .orderBy(desc(sourceDocuments.updatedAt))
      .limit(query.limit)
      .offset(query.offset)
      .pipe(Effect.orDie);

    const totalRows = yield* db
      .select({ total: count() })
      .from(sourceDocuments)
      .where(where)
      .pipe(Effect.orDie);
    const totalRow = yield* firstOrDie(totalRows, "Failed to count source documents");

    const facetRows = yield* db
      .select({ value: sourceDocuments.sourceType, count: count() })
      .from(sourceDocuments)
      .where(eq(sourceDocuments.vaultId, scope.vaultId))
      .groupBy(sourceDocuments.sourceType)
      .orderBy(desc(count()), asc(sourceDocuments.sourceType))
      .pipe(Effect.orDie);

    return SourceDocumentPageSchema.parse({
      items: rows,
      pagination: {
        limit: query.limit,
        offset: query.offset,
        total: totalRow.total,
      },
      facets: { sourceTypes: facetRows },
    });
  });
}

function createSourceDocument(
  scope: VaultScope,
  input: SourceDocumentCreate,
): Effect.Effect<SourceDocument, StorageOperationFailed | VaultUnavailable, Db | VaultStorage> {
  return Effect.gen(function* () {
    const db = yield* Db;
    const storage = yield* VaultStorage;
    const vault = yield* loadVaultInternal(scope);
    const filePath = rawDocPath(input.destPath);
    const content = buildSourceDocument(input);
    const written = yield* storage.writeText(vault, filePath, content);
    const values = {
      vaultId: scope.vaultId,
      filePath,
      fileHash: fileHash(content),
      bodyHash: bodyHash(markdownBody(content)),
      clientHash: input.clientHash,
      etag: written.etag,
      sourceType: input.sourceType,
      url: input.url,
      origin: input.origin,
      updatedAt: new Date(),
    };

    const rows = yield* db
      .insert(sourceDocuments)
      .values(values)
      .onConflictDoUpdate({
        target: [sourceDocuments.vaultId, sourceDocuments.filePath],
        set: {
          fileHash: values.fileHash,
          bodyHash: values.bodyHash,
          clientHash: values.clientHash,
          etag: values.etag,
          sourceType: values.sourceType,
          url: values.url,
          origin: values.origin,
          updatedAt: values.updatedAt,
        },
      })
      .returning()
      .pipe(Effect.orDie);

    const document = yield* firstOrDie(rows, "Failed to create source document");
    return SourceDocumentSchema.parse(document);
  });
}

function deleteSourceDocument(
  scope: VaultScope,
  input: SourceDocumentDelete,
): Effect.Effect<
  void,
  SourceDocumentUnavailable | StorageOperationFailed | VaultForbidden | VaultUnavailable,
  Db | VaultStorage
> {
  return Effect.gen(function* () {
    const db = yield* Db;
    const storage = yield* VaultStorage;
    const { filePath } = SourceDocumentDeleteSchema.parse(input);
    const vault = yield* loadVaultInternal(scope);

    yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* assertOwnVault(tx, scope);
          const rows = yield* tx
            .delete(sourceDocuments)
            .where(
              and(
                eq(sourceDocuments.vaultId, scope.vaultId),
                eq(sourceDocuments.filePath, filePath),
              ),
            )
            .returning({ id: sourceDocuments.id })
            .pipe(Effect.orDie);

          yield* firstOrFail(
            rows,
            () => new SourceDocumentUnavailable({ message: "Source not found" }),
          );
        }),
      )
      .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));

    yield* storage.deleteText(vault, filePath);
  });
}

function loadVaultInternal(scope: VaultScope) {
  return Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* db
      .select({ vault: vaults })
      .from(vaultMemberships)
      .innerJoin(vaults, eq(vaults.id, vaultMemberships.vaultId))
      .where(
        and(eq(vaultMemberships.userId, scope.userId), eq(vaultMemberships.vaultId, scope.vaultId)),
      )
      .limit(1)
      .pipe(Effect.orDie);

    const row = yield* firstOrFail(rows, () => new VaultUnavailable());
    return VaultInternalSchema.parse(row.vault);
  });
}

function assertOwnVault(
  db: DbSession,
  scope: VaultScope,
): Effect.Effect<void, VaultForbidden | VaultUnavailable> {
  return Effect.gen(function* () {
    const role = yield* loadVaultRole(db, scope);
    if (!role) return yield* Effect.fail(new VaultUnavailable());
    if (role !== "owner")
      return yield* Effect.fail(new VaultForbidden({ message: "Vault owner permission required" }));
  });
}

function loadVaultRole(db: DbSession, scope: VaultScope) {
  return Effect.gen(function* () {
    const rows = yield* db
      .select({ role: vaultMemberships.role })
      .from(vaultMemberships)
      .where(
        and(eq(vaultMemberships.userId, scope.userId), eq(vaultMemberships.vaultId, scope.vaultId)),
      )
      .limit(1)
      .pipe(Effect.orDie);

    return rows[0]?.role;
  });
}

function rawDocPath(destPath: string): string {
  const normalized = path.posix.normalize(destPath);
  const parsed = path.posix.parse(normalized);
  return path.posix.join("raw", "docs", parsed.dir, `${parsed.name}.md`);
}

function buildSourceDocument(input: SourceDocumentCreate): string {
  return `${sourceFrontmatter(input)}${input.content}`;
}

function sourceFrontmatter(input: SourceDocumentCreate): string {
  const fields = {
    source_type: input.sourceType,
    url: input.url,
    origin: input.origin,
  };
  const lines = Object.entries(fields)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  return `---\n${lines.join("\n")}\n---\n`;
}

function markdownBody(content: string): string {
  const match = /^---\n[\s\S]+?\n---\n/.exec(content);
  return match ? content.slice(match[0].length) : content;
}

function fileHash(content: string): string {
  return contentHash("file", content);
}

function bodyHash(body: string): string {
  return contentHash("body", body);
}

function contentHash(...parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    const bytes = Buffer.from(part);
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32LE(bytes.byteLength);
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function sourceFilter(vaultId: VaultId, query: SourceListQuery): SQL {
  const conditions: SQL[] = [eq(sourceDocuments.vaultId, vaultId)];

  if (query.sourceType) conditions.push(eq(sourceDocuments.sourceType, query.sourceType));

  if (query.search) {
    const pattern = `%${query.search}%`;
    conditions.push(
      or(
        ilike(sourceDocuments.filePath, pattern),
        ilike(sourceDocuments.title, pattern),
        ilike(sourceDocuments.author, pattern),
        ilike(sourceDocuments.origin, pattern),
        ilike(sourceDocuments.precis, pattern),
      )!,
    );
  }

  return and(...conditions)!;
}
