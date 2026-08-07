import { randomUUID } from "node:crypto";

import { compileIntents, Database, sourceProposals } from "@great-minds/database";
import {
  BadRequest,
  Conflict,
  Forbidden,
  NotFound,
  type PageParams,
  type Proposal,
  type ProposalCreate,
  type ProposalOverview,
  type ProposalPage,
  type ProposalStatus,
  type ProposalUpdate,
  type Uuid,
} from "@great-minds/domain";
import { and, desc, eq, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { stringify as stringifyYaml } from "yaml";

import { pageEnvelope, oneTotal } from "./pagination.ts";
import { ProposalStorage, VaultStorage } from "./storage.ts";
import { SourceDocumentsService } from "./source-documents.ts";
import { VaultAccessService } from "./vaults.ts";

const SOURCE_DELETION_CONTENT_TYPE = "source_deletion";

type DbProposal = typeof sourceProposals.$inferSelect;

type SourceForDeletion = {
  readonly filePath: string;
  readonly title: string | null;
};

type ProposalsServiceShape = {
  readonly createRendered: (
    vaultId: Uuid,
    userId: Uuid,
    data: {
      readonly contentType: string;
      readonly title: string | null;
      readonly author: string | null;
      readonly destPath: string;
      readonly rendered: string;
    },
  ) => Effect.Effect<Proposal>;
  readonly create: (
    userId: Uuid,
    vaultId: Uuid,
    input: ProposalCreate,
  ) => Effect.Effect<Proposal, BadRequest | Forbidden>;
  readonly findPendingForDest: (
    vaultId: Uuid,
    destPath: string,
  ) => Effect.Effect<Proposal | undefined>;
  readonly createSourceDeletionRequest: (
    vaultId: Uuid,
    userId: Uuid,
    source: SourceForDeletion,
  ) => Effect.Effect<Proposal, Conflict>;
  readonly list: (
    userId: Uuid,
    vaultId: Uuid,
    query: PageParams & { readonly status?: ProposalStatus },
  ) => Effect.Effect<ProposalPage, Forbidden>;
  readonly get: (
    userId: Uuid,
    vaultId: Uuid,
    proposalId: Uuid,
  ) => Effect.Effect<Proposal, Forbidden | NotFound>;
  readonly review: (
    userId: Uuid,
    vaultId: Uuid,
    proposalId: Uuid,
    input: ProposalUpdate,
  ) => Effect.Effect<Proposal, Conflict | Forbidden | NotFound>;
};

export class ProposalsService extends Context.Service<ProposalsService, ProposalsServiceShape>()(
  "@great-minds/server/ProposalsService",
) {}

const statusFromDb = (status: DbProposal["status"]): ProposalStatus => {
  switch (status) {
    case "PENDING":
      return "pending";
    case "APPROVED":
      return "approved";
    case "REJECTED":
      return "rejected";
  }
};

const statusToDb = (status: ProposalStatus): DbProposal["status"] => {
  switch (status) {
    case "pending":
      return "PENDING";
    case "approved":
      return "APPROVED";
    case "rejected":
      return "REJECTED";
  }
};

const proposalOverview = (row: DbProposal): ProposalOverview => ({
  id: row.id as Uuid,
  vault_id: row.vaultId as Uuid,
  status: statusFromDb(row.status),
  title: row.title,
  content_type: row.contentType,
  created_at: row.createdAt.toISOString(),
});

const proposalResponse = (row: DbProposal): Proposal => ({
  ...proposalOverview(row),
  user_id: row.userId as Uuid,
  author: row.author,
  dest_path: row.destPath,
  document_id: row.documentId as Uuid | null,
});

const proposalStagingPath = (proposalId: Uuid) => `${proposalId}.md`;

const safeSegment = (value: string) => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "user";
};

const buildDocument = (content: string, sourceType: string) =>
  `---\n${stringifyYaml({ source_type: sourceType })}---\n${content}\n`;

const sourceDeletionDocument = (source: SourceForDeletion) =>
  "---\n" +
  stringifyYaml({
    source_type: SOURCE_DELETION_CONTENT_TYPE,
    source_doc_path: source.filePath,
  }) +
  "---\n" +
  `Request deletion of \`${source.filePath}\`.\n`;

export const ProposalsServiceLive = Layer.effect(
  ProposalsService,
  Effect.gen(function* () {
    const db = yield* Database;
    const access = yield* VaultAccessService;
    const proposalStorage = yield* ProposalStorage;
    const vaultStorage = yield* VaultStorage;
    const sourceDocuments = yield* SourceDocumentsService;

    const insertProposal = (
      vaultId: Uuid,
      userId: Uuid,
      data: {
        readonly id?: Uuid;
        readonly contentType: string;
        readonly title: string | null;
        readonly author: string | null;
        readonly destPath: string;
        readonly rendered: string;
      },
    ) =>
      Effect.gen(function* () {
        const proposalId = data.id ?? (randomUUID() as Uuid);
        const rows = yield* db.query((d) => d
          .insert(sourceProposals)
          .values({
            id: proposalId,
            vaultId,
            userId,
            status: "PENDING",
            contentType: data.contentType,
            title: data.title,
            author: data.author,
            destPath: data.destPath,
          })
          .returning());
        const proposal = rows[0];
        if (proposal === undefined) {
          throw new Error("proposal insert returned no row");
        }
        yield* proposalStorage.writeText(proposalStagingPath(proposalId), data.rendered);
        return proposalResponse(proposal);
      });

    const getForVault = (vaultId: Uuid, proposalId: Uuid) =>
      Effect.gen(function* () {
        const rows = yield* db.query((d) => d
          .select()
          .from(sourceProposals)
          .where(and(eq(sourceProposals.vaultId, vaultId), eq(sourceProposals.id, proposalId)))
          .limit(1));
        return rows[0];
      });

    const ensureCompileIntent = (vaultId: Uuid) =>
      db.query((d) => d
        .insert(compileIntents)
        .values({ vaultId })
        .onConflictDoUpdate({
          target: compileIntents.vaultId,
          targetWhere: sql`${compileIntents.dispatchedAt} IS NULL`,
          set: { vaultId: sql`compile_intents.vault_id` },
        })
        .returning({ id: compileIntents.id }));

    return {
      createRendered: (vaultId, userId, data) =>
        insertProposal(vaultId, userId, {
          contentType: data.contentType,
          title: data.title,
          author: data.author,
          destPath: data.destPath,
          rendered: data.rendered,
        }),
      create: (userId, vaultId, input) =>
        Effect.gen(function* () {
          yield* access.requireEditor(userId, vaultId);
          const content = input.content.trim();
          if (content.length === 0) {
            return yield* new BadRequest({ detail: "content required" });
          }
          const contentType = input.content_type?.trim() || "user_suggestion";
          const proposalId = randomUUID() as Uuid;
          return yield* insertProposal(vaultId, userId, {
            id: proposalId,
            contentType,
            title: input.title?.trim() || null,
            author: input.author?.trim() || null,
            destPath: `raw/${safeSegment(contentType)}/${proposalId}.md`,
            rendered: buildDocument(content, contentType),
          });
        }),
      findPendingForDest: (vaultId, destPath) =>
        Effect.gen(function* () {
          const rows = yield* db.query((d) => d
            .select()
            .from(sourceProposals)
            .where(
              and(
                eq(sourceProposals.vaultId, vaultId),
                eq(sourceProposals.destPath, destPath),
                eq(sourceProposals.status, "PENDING"),
              ),
            )
            .limit(1));
          const row = rows[0];
          return row === undefined ? undefined : proposalResponse(row);
        }),
      createSourceDeletionRequest: (vaultId, userId, source) =>
        Effect.gen(function* () {
          const existingRows = yield* db.query((d) => d
            .select()
            .from(sourceProposals)
            .where(
              and(
                eq(sourceProposals.vaultId, vaultId),
                eq(sourceProposals.destPath, source.filePath),
                eq(sourceProposals.status, "PENDING"),
              ),
            )
            .limit(1));
          const existing = existingRows[0];
          if (existing !== undefined) {
            if (existing.contentType === SOURCE_DELETION_CONTENT_TYPE) {
              return proposalResponse(existing);
            }
            return yield* new Conflict({
              detail: "A pending proposal already targets this source",
            });
          }
          const sourceLabel = source.title ?? source.filePath;
          return yield* insertProposal(vaultId, userId, {
            contentType: SOURCE_DELETION_CONTENT_TYPE,
            title: `Delete source: ${sourceLabel}`,
            author: null,
            destPath: source.filePath,
            rendered: sourceDeletionDocument(source),
          });
        }),
      list: (userId, vaultId, query) =>
        Effect.gen(function* () {
          yield* access.requireMember(userId, vaultId);
          const where =
            query.status === undefined
              ? eq(sourceProposals.vaultId, vaultId)
              : and(eq(sourceProposals.vaultId, vaultId), eq(sourceProposals.status, statusToDb(query.status)));
          const countRows = yield* db.query((d) => d
            .select({ total: sql<number>`count(*)::int` })
            .from(sourceProposals)
            .where(where));
          const rows = yield* db.query((d) => d
            .select()
            .from(sourceProposals)
            .where(where)
            .orderBy(desc(sourceProposals.createdAt))
            .limit(query.limit)
            .offset(query.offset));
          return pageEnvelope(rows.map(proposalOverview), query, oneTotal(countRows));
        }),
      get: (userId, vaultId, proposalId) =>
        Effect.gen(function* () {
          yield* access.requireMember(userId, vaultId);
          const proposal = yield* getForVault(vaultId, proposalId);
          if (proposal === undefined) {
            return yield* new NotFound({ detail: "Proposal not found" });
          }
          return proposalResponse(proposal);
        }),
      review: (userId, vaultId, proposalId, input) =>
        Effect.gen(function* () {
          yield* access.requireOwner(userId, vaultId);
          const proposal = yield* getForVault(vaultId, proposalId);
          if (proposal === undefined) {
            return yield* new NotFound({ detail: "Proposal not found" });
          }
          if (proposal.status !== "PENDING") {
            return yield* new Conflict({ detail: "Proposal already reviewed" });
          }
          if (input.status === "approved") {
            if (proposal.contentType === SOURCE_DELETION_CONTENT_TYPE) {
              yield* sourceDocuments.deleteSource(vaultId, proposal.destPath, { missingOk: true });
              yield* proposalStorage.deletePath(proposalStagingPath(proposal.id as Uuid));
            } else {
              const rendered = yield* proposalStorage
                .readText(proposalStagingPath(proposal.id as Uuid))
                .pipe(Effect.orDie);
              yield* vaultStorage.writeText(vaultId, proposal.destPath, rendered);
              const documentId = yield* sourceDocuments.index(vaultId, proposal.destPath, rendered);
              yield* db.query((d) => d
                .update(sourceProposals)
                .set({ documentId })
                .where(eq(sourceProposals.id, proposal.id)));
              yield* ensureCompileIntent(vaultId);
            }
          } else {
            yield* proposalStorage.deletePath(proposalStagingPath(proposal.id as Uuid));
          }
          const rows = yield* db.query((d) => d
            .update(sourceProposals)
            .set({ status: statusToDb(input.status) })
            .where(and(eq(sourceProposals.vaultId, vaultId), eq(sourceProposals.id, proposalId)))
            .returning());
          const updated = rows[0];
          if (updated === undefined) {
            throw new Error(`reviewed proposal ${proposalId} not found`);
          }
          return proposalResponse(updated);
        }),
    } satisfies ProposalsServiceShape;
  }),
);
