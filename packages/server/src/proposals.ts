import { randomUUID } from "node:crypto";

import {
  compileIntents,
  Database,
  sourceIncarnations,
  sourceProposals,
  type TransactionClient,
} from "@great-minds/database";
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
  Uuid,
} from "@great-minds/domain";
import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { Cause, Context, Effect, Layer } from "effect";
import { stringify as stringifyYaml } from "yaml";

import { backgroundLoop } from "./background-loop.ts";
import { StructuredLogger } from "./logging.ts";
import { pageEnvelope, oneTotal } from "./pagination.ts";
import { identifySourceMarkdown } from "./source-identity.ts";
import { ProposalStorage } from "./storage.ts";
import {
  admitSource,
  retainSource,
  retireSource,
  type SourceAdmission,
  SourceDocumentsService,
} from "./source-documents.ts";
import { VaultAccessService } from "./vaults.ts";

const SOURCE_DELETION_CONTENT_TYPE = "source_deletion";

type DbProposal = typeof sourceProposals.$inferSelect;

type SourceForDeletion = SourceAdmission & { readonly title: string | null };
type ProposalContent = {
  readonly contentType: string;
  readonly title: string | null;
  readonly author: string | null;
  readonly rendered: string;
};

type ProposalsServiceShape = {
  readonly createRendered: (
    source: SourceAdmission,
    userId: Uuid,
    data: ProposalContent,
  ) => Effect.Effect<Proposal, Conflict>;
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
  readonly reconcileReviewsOnce: () => Effect.Effect<number>;
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
  id: row.id,
  vault_id: row.vaultId,
  status: statusFromDb(row.status),
  title: row.title,
  content_type: row.contentType,
  created_at: row.createdAt,
});

const proposalResponse = (row: DbProposal): Proposal => ({
  ...proposalOverview(row),
  user_id: row.userId,
  author: row.author,
  dest_path: row.destPath,
  source_id: row.sourceId,
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
    source_id: source.id,
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
    const sourceDocuments = yield* SourceDocumentsService;
    const logger = yield* StructuredLogger;

    const insertProposal = (
      tx: TransactionClient,
      source: SourceAdmission,
      userId: Uuid,
      data: ProposalContent,
    ) =>
      Effect.gen(function* () {
        const rows = yield* tx
          .insert(sourceProposals)
          .values({
            id: Uuid.make(randomUUID(), { disableChecks: true }),
            vaultId: source.vaultId,
            userId,
            status: "PENDING",
            contentType: data.contentType,
            title: data.title,
            author: data.author,
            destPath: source.filePath,
            sourceId: source.id,
            sourceIncarnationId: source.incarnationId,
          })
          .returning();
        const proposal = rows[0];
        if (proposal === undefined) throw new Error("proposal insert returned no row");
        return proposal;
      });

    const stageProposal = (proposal: DbProposal, rendered: string) =>
      Effect.gen(function* () {
        yield* proposalStorage.writeText(proposalStagingPath(proposal.id), rendered);
        return proposalResponse(proposal);
      });

    const createRendered = (source: SourceAdmission, userId: Uuid, data: ProposalContent) =>
      Effect.gen(function* () {
        const proposal = yield* db.transaction((tx) =>
          Effect.gen(function* () {
            const current = yield* retainSource(tx, source.vaultId, source.incarnationId);
            return yield* insertProposal(tx, current, userId, data);
          }),
        );
        return yield* stageProposal(proposal, data.rendered);
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

    const claimDecision = (
      tx: TransactionClient,
      proposalId: Uuid,
      status: Exclude<DbProposal["status"], "PENDING">,
    ) =>
      Effect.gen(function* () {
        const rows = yield* tx
          .update(sourceProposals)
          .set({ status, reviewedAt: sql`now()` })
          .where(and(eq(sourceProposals.id, proposalId), eq(sourceProposals.status, "PENDING")))
          .returning();
        const accepted = rows[0];
        if (accepted === undefined) {
          return yield* new Conflict({ detail: "Proposal already reviewed" });
        }
        return accepted;
      });

    const acceptApproval = (proposal: DbProposal, incarnationId: Uuid) =>
      db.transaction((tx) =>
        Effect.gen(function* () {
          const accepted = yield* claimDecision(tx, proposal.id, "APPROVED");
          const source = yield* retainSource(tx, proposal.vaultId, incarnationId);
          if (proposal.contentType !== SOURCE_DELETION_CONTENT_TYPE) {
            return { accepted, retired: null };
          }
          const retired = yield* retireSource(tx, source.vaultId, source.id, source.incarnationId);
          if (retired === null) {
            return yield* new Conflict({
              detail: "The source changed before this deletion was approved",
            });
          }
          return { accepted, retired };
        }),
      );

    const acceptRejection = (proposal: DbProposal) =>
      db.transaction((tx) => claimDecision(tx, proposal.id, "REJECTED"));

    const publishApproved = (proposal: DbProposal) =>
      Effect.gen(function* () {
        if (proposal.sourceIncarnationId === null) {
          throw new Error(`approved proposal ${proposal.id} has no saved source admission`);
        }
        const source = yield* sourceDocuments
          .admission(proposal.vaultId, proposal.sourceIncarnationId)
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (source === undefined) return;
        const rendered = yield* proposalStorage
          .readText(proposalStagingPath(proposal.id))
          .pipe(Effect.orDie);
        yield* sourceDocuments.write(source, rendered, null);
        yield* ensureCompileIntent(proposal.vaultId);
      });

    const markCompleted = (proposalId: Uuid) =>
      Effect.gen(function* () {
        const rows = yield* db.query((d) =>
          d
            .update(sourceProposals)
            .set({ completedAt: sql`coalesce(${sourceProposals.completedAt}, now())` })
            .where(eq(sourceProposals.id, proposalId))
            .returning(),
        );
        const completed = rows[0];
        if (completed === undefined) {
          throw new Error(`reviewed proposal ${proposalId} not found`);
        }
        return completed;
      });

    const finishReview = (proposal: DbProposal) =>
      Effect.gen(function* () {
        if (proposal.status === "PENDING") {
          throw new Error(`proposal ${proposal.id} has no accepted decision to finish`);
        }
        if (
          proposal.status === "APPROVED" &&
          proposal.contentType !== SOURCE_DELETION_CONTENT_TYPE
        ) {
          yield* publishApproved(proposal);
        } else {
          yield* proposalStorage.deletePath(proposalStagingPath(proposal.id));
        }
        return yield* markCompleted(proposal.id);
      });

    const settleReview = (proposal: DbProposal) =>
      finishReview(proposal).pipe(
        Effect.catchTag("Conflict", (conflict) =>
          logger
            .warn("proposal_review.completion_deferred", {
              proposal_id: proposal.id,
              vault_id: proposal.vaultId,
              error_message: conflict.detail,
            })
            .pipe(Effect.as(proposal)),
        ),
      );

    const reconcileReview = (proposal: DbProposal) =>
      settleReview(proposal).pipe(
        Effect.asVoid,
        Effect.catchCause((cause) => {
          if (cause.reasons.length > 0 && cause.reasons.every(Cause.isInterruptReason))
            return Effect.interrupt;
          return logger.warn("proposal_review.reconciliation_deferred", {
            proposal_id: proposal.id,
            vault_id: proposal.vaultId,
            error_message: Cause.pretty(cause),
          });
        }),
      );

    return {
      createRendered,
      create: (userId, vaultId, input) =>
        Effect.gen(function* () {
          yield* access.requireEditor(userId, vaultId);
          const content = input.content.trim();
          if (content.length === 0) {
            return yield* new BadRequest({ detail: "content required" });
          }
          const contentType = input.content_type?.trim() || "user_suggestion";
          if (contentType === SOURCE_DELETION_CONTENT_TYPE) {
            return yield* new BadRequest({
              detail: "Use the source deletion action to request a deletion",
            });
          }
          const sourceId = Uuid.make(randomUUID(), { disableChecks: true });
          const data = {
            contentType,
            title: input.title?.trim() || null,
            author: input.author?.trim() || null,
            rendered: identifySourceMarkdown(buildDocument(content, contentType), sourceId),
          };
          const proposal = yield* db.transaction((tx) =>
            Effect.gen(function* () {
              const source = yield* admitSource(
                tx,
                vaultId,
                sourceId,
                `raw/${safeSegment(contentType)}/${sourceId}.md`,
              );
              return yield* insertProposal(tx, source, userId, data);
            }),
          );
          return yield* stageProposal(proposal, data.rendered);
        }),
      findPendingForDest: (vaultId, destPath) =>
        Effect.gen(function* () {
          const rows = yield* db.query((d) =>
            d
              .select({ proposal: sourceProposals })
              .from(sourceProposals)
              .innerJoin(
                sourceIncarnations,
                eq(sourceIncarnations.id, sourceProposals.sourceIncarnationId),
              )
              .where(
                and(
                  eq(sourceProposals.vaultId, vaultId),
                  eq(sourceProposals.destPath, destPath),
                  eq(sourceProposals.status, "PENDING"),
                  isNull(sourceIncarnations.deletedAt),
                ),
              )
              .limit(1),
          );
          const row = rows[0];
          return row === undefined ? undefined : proposalResponse(row.proposal);
        }),
      createSourceDeletionRequest: (vaultId, userId, source) =>
        Effect.gen(function* () {
          const existingRows = yield* db.query((d) =>
            d
              .select()
              .from(sourceProposals)
              .where(
                and(
                  eq(sourceProposals.vaultId, vaultId),
                  eq(sourceProposals.sourceId, source.id),
                  eq(sourceProposals.sourceIncarnationId, source.incarnationId),
                  eq(sourceProposals.status, "PENDING"),
                ),
              )
              .limit(1),
          );
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
          return yield* createRendered(source, userId, {
            contentType: SOURCE_DELETION_CONTENT_TYPE,
            title: `Delete source: ${sourceLabel}`,
            author: null,
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
          if (input.status === "rejected") {
            const accepted = yield* acceptRejection(proposal);
            return proposalResponse(yield* settleReview(accepted));
          }
          if (proposal.sourceIncarnationId === null) {
            return yield* new Conflict({
              detail: "This proposal predates source ownership tracking. Submit a new proposal.",
            });
          }
          const { accepted, retired } = yield* acceptApproval(
            proposal,
            proposal.sourceIncarnationId,
          );
          if (retired !== null) yield* sourceDocuments.cleanupDeletion(retired);
          return proposalResponse(yield* settleReview(accepted));
        }),
      reconcileReviewsOnce: () =>
        Effect.gen(function* () {
          const rows = yield* db.query((d) =>
            d
              .select()
              .from(sourceProposals)
              .where(
                and(isNotNull(sourceProposals.reviewedAt), isNull(sourceProposals.completedAt)),
              )
              .orderBy(asc(sourceProposals.reviewedAt))
              .limit(100),
          );
          yield* Effect.forEach(rows, reconcileReview, { concurrency: 4 });
          return rows.length;
        }),
    } satisfies ProposalsServiceShape;
  }),
);

export const ProposalReviewReconcilerLoopLive = Layer.effectDiscard(
  Effect.flatMap(ProposalsService, (service) =>
    backgroundLoop({
      failureEvent: "proposal_review.reconciler_tick_failed",
      interval: "1 minute",
      tick: service.reconcileReviewsOnce(),
    }),
  ),
);
