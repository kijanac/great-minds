import { Database, sourceDocuments } from "@great-minds/database";
import {
  BadRequest,
  Conflict,
  Forbidden,
  NotFound,
  type Proposal,
  type SourceDocumentPage,
  type SourceDocumentSummary,
  type SourceListQuery,
  type Uuid
} from "@great-minds/domain";
import { and, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { pageEnvelope, oneTotal } from "./pagination.ts";
import { ProposalsService } from "./proposals.ts";
import { safeRawSourcePath, SourceDocumentsService } from "./source-documents.ts";
import { VaultAccessService } from "./vaults.ts";

type SourcesServiceShape = {
  readonly listSources: (
    userId: Uuid,
    vaultId: Uuid,
    query: SourceListQuery
  ) => Effect.Effect<SourceDocumentPage, Forbidden>;
  readonly deleteSource: (
    userId: Uuid,
    vaultId: Uuid,
    path: string
  ) => Effect.Effect<void, BadRequest | Forbidden | NotFound>;
  readonly requestSourceDeletion: (
    userId: Uuid,
    vaultId: Uuid,
    path: string
  ) => Effect.Effect<Proposal, BadRequest | Conflict | Forbidden | NotFound>;
};

export class SourcesService extends Context.Service<SourcesService, SourcesServiceShape>()(
  "@great-minds/server/SourcesService"
) {}

const DerivedExtras = Schema.Record(Schema.String, Schema.Unknown);
const decodeDerivedExtras = Schema.decodeUnknownSync(DerivedExtras);

const sourceSummary = (
  row: typeof sourceDocuments.$inferSelect
): SourceDocumentSummary => ({
  file_path: row.filePath,
  source_type: row.sourceType,
  title: row.title,
  author: row.author,
  published_date: row.publishedDate,
  url: row.url,
  origin: row.origin,
  genre: row.genre,
  precis: row.precis,
  tags: row.tags,
  derived_extras: decodeDerivedExtras(row.derivedExtras),
  updated_at: row.updatedAt.toISOString()
});

const sourceConditions = (vaultId: Uuid, query: SourceListQuery) => {
  const conditions: SQL[] = [eq(sourceDocuments.vaultId, vaultId)];
  if (query.source_type !== undefined && query.source_type !== "") {
    conditions.push(eq(sourceDocuments.sourceType, query.source_type));
  }
  if (query.search !== undefined && query.search !== "") {
    const pattern = `%${query.search}%`;
    const searchCondition = or(
      ilike(sourceDocuments.title, pattern),
      ilike(sourceDocuments.author, pattern)
    );
    if (searchCondition !== undefined) {
      conditions.push(searchCondition);
    }
  }
  return conditions;
};

export const SourcesServiceLive = Layer.effect(
  SourcesService,
  Effect.gen(function* () {
    const db = yield* Database;
    const access = yield* VaultAccessService;
    const sourceDocumentsWrite = yield* SourceDocumentsService;
    const proposals = yield* ProposalsService;

    return {
      listSources: (userId, vaultId, query) =>
        Effect.gen(function* () {
          yield* access.requireMember(userId, vaultId);
          const where = and(...sourceConditions(vaultId, query));
          const countRows = yield* db.query((d) => d
            .select({ total: sql<number>`count(*)::int` })
            .from(sourceDocuments)
            .where(where));
          const rows = yield* db.query((d) => d
            .select()
            .from(sourceDocuments)
            .where(where)
            .orderBy(desc(sourceDocuments.updatedAt))
            .limit(query.limit)
            .offset(query.offset));
          const facetRows = yield* db.query((d) => d
            .select({
              value: sourceDocuments.sourceType,
              count: sql<number>`count(*)::int`
            })
            .from(sourceDocuments)
            .where(eq(sourceDocuments.vaultId, vaultId))
            .groupBy(sourceDocuments.sourceType)
            .orderBy(desc(sql`count(*)`)));

          return {
            ...pageEnvelope(rows.map(sourceSummary), query, oneTotal(countRows)),
            facets: {
              source_types: facetRows
            }
          };
        }),
      deleteSource: (userId, vaultId, path) =>
        Effect.gen(function* () {
          const sourcePath = safeRawSourcePath(path);
          if (sourcePath === undefined) {
            return yield* new BadRequest({ detail: `Invalid source path: ${path}` });
          }
          yield* access.requireOwner(userId, vaultId);
          const deleted = yield* sourceDocumentsWrite.deleteSource(vaultId, sourcePath);
          if (!deleted) {
            return yield* new NotFound({ detail: "Source not found" });
          }
        }),
      requestSourceDeletion: (userId, vaultId, path) =>
        Effect.gen(function* () {
          const sourcePath = safeRawSourcePath(path);
          if (sourcePath === undefined) {
            return yield* new BadRequest({ detail: `Invalid source path: ${path}` });
          }
          const scope = yield* access.requireMember(userId, vaultId);
          if (scope.role === "viewer") {
            return yield* new Forbidden({ detail: "Viewers cannot request source deletion" });
          }
          if (scope.role === "owner") {
            return yield* new BadRequest({ detail: "Owners should delete sources directly" });
          }
          if (scope.role !== "editor") {
            return yield* new Forbidden({ detail: "Only editors can request source deletion" });
          }
          const source = yield* sourceDocumentsWrite.getByPath(vaultId, sourcePath);
          if (source === undefined) {
            return yield* new NotFound({ detail: "Source not found" });
          }
          return yield* proposals.createSourceDeletionRequest(vaultId, userId, {
            filePath: source.filePath,
            title: source.title
          });
        })
    } satisfies SourcesServiceShape;
  })
);
