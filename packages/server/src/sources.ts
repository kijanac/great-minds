import { Database, sourceDocuments } from "@great-minds/database";
import {
  BadRequest,
  Conflict,
  Forbidden,
  NotFound,
  type Proposal,
  type SourceDocumentPage,
  type SourceListQuery,
  type SourceQuery,
  type SourceQueryPage,
  type Uuid,
} from "@great-minds/domain";
import { and, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";

import { readSourceSummary } from "./document-metadata.ts";
import { querySourceRows, tagCondition } from "./source-query.ts";
import { ContentStorage } from "./storage.ts";
import { defaultVaultConfigFile, readVaultConfig } from "./vault-config.ts";
import { pageEnvelope, oneTotal } from "./pagination.ts";
import { ProposalsService } from "./proposals.ts";
import { SourceDocumentsService } from "./source-documents.ts";
import { VaultAccessService } from "./vaults.ts";

type SourcesServiceShape = {
  readonly listSources: (
    userId: Uuid,
    vaultId: Uuid,
    query: SourceListQuery,
  ) => Effect.Effect<SourceDocumentPage, Forbidden>;
  readonly querySources: (
    userId: Uuid,
    vaultId: Uuid,
    query: SourceQuery,
  ) => Effect.Effect<SourceQueryPage, BadRequest | Forbidden>;
  readonly deleteSource: (
    userId: Uuid,
    vaultId: Uuid,
    sourceId: Uuid,
  ) => Effect.Effect<void, BadRequest | Forbidden | NotFound>;
  readonly requestSourceDeletion: (
    userId: Uuid,
    vaultId: Uuid,
    sourceId: Uuid,
  ) => Effect.Effect<Proposal, BadRequest | Conflict | Forbidden | NotFound>;
};

export class SourcesService extends Context.Service<SourcesService, SourcesServiceShape>()(
  "@great-minds/server/SourcesService",
) {}

const sourceConditions = (vaultId: Uuid, query: SourceListQuery) => {
  const conditions: SQL[] = [eq(sourceDocuments.vaultId, vaultId)];
  if (query.source_type !== undefined && query.source_type !== "") {
    conditions.push(eq(sourceDocuments.sourceType, query.source_type));
  }
  if (query.search !== undefined && query.search !== "") {
    const pattern = `%${query.search}%`;
    const searchCondition = or(
      ilike(sourceDocuments.title, pattern),
      ilike(sourceDocuments.author, pattern),
    );
    if (searchCondition !== undefined) {
      conditions.push(searchCondition);
    }
  }
  if (query.tag !== undefined && query.tag !== "") {
    conditions.push(tagCondition(query.tag));
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
    const storage = yield* ContentStorage;

    return {
      listSources: (userId, vaultId, query) =>
        Effect.gen(function* () {
          yield* access.requireMember(userId, vaultId);
          const where = and(...sourceConditions(vaultId, query));
          const countRows = yield* db.query((d) =>
            d
              .select({ total: sql<number>`count(*)::int` })
              .from(sourceDocuments)
              .where(where),
          );
          const rows = yield* db.query((d) =>
            d
              .select()
              .from(sourceDocuments)
              .where(where)
              .orderBy(desc(sourceDocuments.updatedAt), sourceDocuments.id)
              .limit(query.limit)
              .offset(query.offset),
          );
          const facetWhere = and(
            eq(sourceDocuments.vaultId, vaultId),
            ...(query.tag !== undefined && query.tag !== "" ? [tagCondition(query.tag)] : []),
          );
          const facetRows = yield* db.query((d) =>
            d
              .select({
                value: sourceDocuments.sourceType,
                count: sql<number>`count(*)::int`,
              })
              .from(sourceDocuments)
              .where(facetWhere)
              .groupBy(sourceDocuments.sourceType)
              .orderBy(desc(sql`count(*)`)),
          );

          return {
            ...pageEnvelope(
              yield* Effect.forEach(rows, readSourceSummary),
              query,
              oneTotal(countRows),
            ),
            facets: {
              source_types: facetRows,
            },
          };
        }),
      querySources: (userId, vaultId, query) =>
        Effect.gen(function* () {
          yield* access.requireMember(userId, vaultId);
          const config = yield* readVaultConfig(storage, vaultId).pipe(
            Effect.catchTag("VaultConfigMalformed", () => Effect.succeed(defaultVaultConfigFile)),
          );
          const page = yield* querySourceRows(db, vaultId, config, query, 50);
          return pageEnvelope(
            yield* Effect.forEach(page.rows, readSourceSummary),
            { limit: page.limit, offset: page.offset },
            page.total,
          );
        }),
      deleteSource: (userId, vaultId, sourceId) =>
        Effect.gen(function* () {
          yield* access.requireOwner(userId, vaultId);
          const deleted = yield* sourceDocumentsWrite.deleteSource(vaultId, sourceId);
          if (!deleted) {
            return yield* new NotFound({ detail: "Source not found" });
          }
        }),
      requestSourceDeletion: (userId, vaultId, sourceId) =>
        Effect.gen(function* () {
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
          const source = yield* sourceDocumentsWrite.getById(vaultId, sourceId);
          if (source === undefined) {
            return yield* new NotFound({ detail: "Source not found" });
          }
          return yield* proposals.createSourceDeletionRequest(vaultId, userId, source);
        }),
    } satisfies SourcesServiceShape;
  }),
);
