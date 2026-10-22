import { randomUUID } from "node:crypto";

import {
  Database,
  sessions,
  shares,
  type TransactionClient,
  users,
  vaultMemberships,
  vaults,
  wikiArticles,
} from "@great-minds/database";
import {
  type AssignableMemberRole,
  BadRequest,
  Email,
  Forbidden,
  type MemberPage,
  type MemberRole,
  type MemberWithEmail,
  NotFound,
  type OwnershipTransfer,
  type PageParams,
  Uuid,
  type Vault,
  type VaultConfig,
  type VaultConfigUpdate,
  type VaultDetail,
  type VaultPage,
  type VaultRename,
} from "@great-minds/domain";
import { and, asc, desc, eq, inArray, isNotNull, isNull, notExists, sql } from "drizzle-orm";
import { Cause, Context, Effect, Layer, Schema } from "effect";
import { parseDocument } from "yaml";

import { backgroundLoop } from "./background-loop.ts";
import { StructuredLogger } from "./logging.ts";
import { Mailer } from "./mailer.ts";
import { pageEnvelope, oneTotal } from "./pagination.ts";
import { ContentStorage, StagedStorage, userOwner, vaultOwner } from "./storage.ts";
import { readVaultConfig, VAULT_CONFIG_PATH } from "./vault-config.ts";
import { liveArticleConditions } from "./wiki-articles.ts";

type CountRow = {
  readonly count: number;
};

type DbMemberRole = typeof vaultMemberships.$inferSelect.role;

type VaultScope = {
  readonly vaultId: Uuid;
  readonly userId: Uuid;
  readonly role: MemberRole;
};

type VaultAccessServiceShape = {
  readonly requireMember: (
    userId: Uuid,
    vaultId: Uuid,
    detail?: string,
  ) => Effect.Effect<VaultScope, Forbidden>;
  readonly requireEditor: (userId: Uuid, vaultId: Uuid) => Effect.Effect<VaultScope, Forbidden>;
  readonly requireOwner: (userId: Uuid, vaultId: Uuid) => Effect.Effect<VaultScope, Forbidden>;
};

type VaultsServiceShape = {
  readonly ensureDefaultForUser: (userId: Uuid, email: Email) => Effect.Effect<void>;
  readonly deleteAccount: (userId: Uuid) => Effect.Effect<void, NotFound>;
  readonly reconcileDeletionsOnce: () => Effect.Effect<number>;
  readonly createVault: (
    userId: Uuid,
    input: {
      readonly name: string;
      readonly thematic_hint?: string;
      readonly kinds?: readonly string[];
    },
  ) => Effect.Effect<Vault>;
  readonly listVaults: (userId: Uuid, params: PageParams) => Effect.Effect<VaultPage>;
  readonly getVaultDetail: (userId: Uuid, vaultId: Uuid) => Effect.Effect<VaultDetail, Forbidden>;
  readonly renameVault: (
    userId: Uuid,
    vaultId: Uuid,
    input: VaultRename,
  ) => Effect.Effect<void, Forbidden>;
  readonly getVaultConfig: (userId: Uuid, vaultId: Uuid) => Effect.Effect<VaultConfig, Forbidden>;
  readonly updateVaultConfig: (
    userId: Uuid,
    vaultId: Uuid,
    input: VaultConfigUpdate,
  ) => Effect.Effect<VaultConfig, Forbidden>;
  readonly listMembers: (
    userId: Uuid,
    vaultId: Uuid,
    params: PageParams,
  ) => Effect.Effect<MemberPage, Forbidden>;
  readonly inviteMember: (
    userId: Uuid,
    vaultId: Uuid,
    input: { readonly email: Email; readonly role?: AssignableMemberRole },
  ) => Effect.Effect<MemberWithEmail, BadRequest | Forbidden>;
  readonly updateMemberRole: (
    userId: Uuid,
    vaultId: Uuid,
    memberUserId: Uuid,
    role: AssignableMemberRole,
  ) => Effect.Effect<MemberWithEmail, BadRequest | Forbidden | NotFound>;
  readonly removeMember: (
    userId: Uuid,
    vaultId: Uuid,
    memberUserId: Uuid,
  ) => Effect.Effect<void, BadRequest | Forbidden | NotFound>;
  readonly transferOwnership: (
    userId: Uuid,
    vaultId: Uuid,
    input: OwnershipTransfer,
  ) => Effect.Effect<void, BadRequest | Forbidden>;
  readonly deleteVault: (userId: Uuid, vaultId: Uuid) => Effect.Effect<void, Forbidden | NotFound>;
};

export class VaultAccessService extends Context.Service<
  VaultAccessService,
  VaultAccessServiceShape
>()("@great-minds/server/VaultAccessService") {}

export class VaultsService extends Context.Service<VaultsService, VaultsServiceShape>()(
  "@great-minds/server/VaultsService",
) {}

export const defaultVaultConfigText = `name: "Personal Vault"

# Idea-level kind taxonomy. Constrains what the extract LLM can classify
# ideas as; "other" is always accepted as fallback.
kinds:
  - person
  - event
  - organization
  - concept

# Optional free-text steer prepended to reduce's prompt. Shapes how the
# reducer frames canonical topics (e.g. "prefer events and debates over
# biographical framings"). Empty string disables the steer.
thematic_hint: ""

# Answer-time policy: may query answers draw on the open web for facts the
# knowledge base doesn't contain? Web results are cited as external links,
# never blended into the knowledge base's own voice. (Requires PARALLEL_API_KEY.)
web_search: false

# Vault-configured enriched metadata fields. Each entry declares a field
# the extract LLM should look for in every document. The LLM's value
# lands in source_documents.derived_extras (JSONB) and gets surfaced in
# compile's editorial context (partition / synthesize per-doc context)
# automatically.
#
# Curator never fills these — extract owns them end-to-end. A vault with
# no \`metadata:\` block gets no extra enriched fields; the universal
# title/precis/genre/tags/author/published_date set is always populated.
metadata:
  tradition:
    type: string
    description: >-
      the intellectual or political tradition this text belongs to
      (e.g. "marxist-leninist", "anarchist", "liberal"). Use a short
      lowercase label. Empty string if unclear.
  interlocutors:
    type: list
    description: >-
      names of thinkers, writers, or figures this text is responding to,
      arguing against, or in direct dialogue with. Empty list if none.
`;

const uuidOf = Schema.decodeSync(Uuid);

const asEmail = (value: string): Email => value as Email;

const normalizeEmail = (email: Email) => asEmail(email.trim().toLowerCase());

const roleFromDb = (role: DbMemberRole): AssignableMemberRole => {
  switch (role) {
    case "EDITOR":
      return "editor";
    case "VIEWER":
      return "viewer";
  }
};

const memberRole = (ownerId: Uuid, userId: Uuid, role: DbMemberRole): MemberRole =>
  ownerId === userId ? "owner" : roleFromDb(role);

const roleToDb = (role: AssignableMemberRole): DbMemberRole => {
  switch (role) {
    case "editor":
      return "EDITOR";
    case "viewer":
      return "VIEWER";
  }
};

const vaultResponse = (row: {
  readonly id: Uuid;
  readonly name: string;
  readonly ownerId: Uuid;
  readonly createdAt: Date;
}) => ({
  id: row.id,
  name: row.name,
  owner_id: row.ownerId,
  created_at: row.createdAt,
});

const memberResponse = (row: {
  readonly userId: Uuid;
  readonly email: string;
  readonly role: DbMemberRole;
  readonly ownerId: Uuid;
}): MemberWithEmail => ({
  user_id: row.userId,
  email: asEmail(row.email),
  role: memberRole(row.ownerId, row.userId, row.role),
});

const ownerOnly = () => new Forbidden({ detail: "Only vault owners can perform this action" });

const vaultBeingDeleted = () => new Forbidden({ detail: "This vault is being deleted" });

const oneCount = (rows: readonly CountRow[]) => {
  const row = rows[0];
  if (row === undefined) {
    throw new Error("count query returned no rows");
  }
  return row.count;
};

const lockOwnedVault = (tx: TransactionClient, userId: Uuid, vaultId: Uuid) =>
  Effect.gen(function* () {
    const [vault] = yield* tx
      .select({ ownerId: vaults.ownerId, deletedAt: vaults.deletedAt })
      .from(vaults)
      .where(eq(vaults.id, vaultId))
      .for("no key update");
    if (vault?.ownerId !== userId) return yield* ownerOnly();
    if (vault.deletedAt !== null) return yield* vaultBeingDeleted();
    return vault;
  });

const accountBeingDeleted = () => new BadRequest({ detail: "That account is being deleted" });

const lockTransferTarget = (tx: TransactionClient, vaultId: Uuid, userId: Uuid) =>
  Effect.gen(function* () {
    const [target] = yield* tx
      .select({ deletedAt: users.deletedAt })
      .from(vaultMemberships)
      .innerJoin(users, eq(users.id, vaultMemberships.userId))
      .where(and(eq(vaultMemberships.vaultId, vaultId), eq(vaultMemberships.userId, userId)))
      .for("share", { of: users });
    if (target === undefined) {
      return yield* new BadRequest({
        detail: `User ${userId} is not a member of vault ${vaultId}`,
      });
    }
    if (target.deletedAt !== null) return yield* accountBeingDeleted();
  });

export const VaultAccessServiceLive = Layer.effect(
  VaultAccessService,
  Effect.gen(function* () {
    const db = yield* Database;

    const requireMember = (
      userId: Uuid,
      vaultId: Uuid,
      detail = "Only vault members can perform this action",
    ) =>
      Effect.gen(function* () {
        const rows = yield* db.query((d) =>
          d
            .select({
              role: vaultMemberships.role,
              ownerId: vaults.ownerId,
              deletedAt: vaults.deletedAt,
            })
            .from(vaultMemberships)
            .innerJoin(vaults, eq(vaults.id, vaultMemberships.vaultId))
            .where(and(eq(vaultMemberships.userId, userId), eq(vaultMemberships.vaultId, vaultId)))
            .limit(1),
        );
        const row = rows[0];
        if (row === undefined) {
          return yield* new Forbidden({ detail });
        }
        if (row.deletedAt !== null) return yield* vaultBeingDeleted();
        return {
          vaultId,
          userId,
          role: memberRole(row.ownerId, userId, row.role),
        };
      });

    return {
      requireMember,
      requireOwner: (userId, vaultId) =>
        Effect.gen(function* () {
          const scope = yield* requireMember(
            userId,
            vaultId,
            "Only vault owners can perform this action",
          );
          if (scope.role !== "owner") return yield* ownerOnly();
          return scope;
        }),
      requireEditor: (userId, vaultId) =>
        Effect.gen(function* () {
          const scope = yield* requireMember(
            userId,
            vaultId,
            "Only vault editors or owners can perform this action",
          );
          if (scope.role === "viewer") {
            return yield* new Forbidden({
              detail: "Only vault editors or owners can perform this action",
            });
          }
          return scope;
        }),
    } satisfies VaultAccessServiceShape;
  }),
);

export const VaultsServiceLive = Layer.effect(
  VaultsService,
  Effect.gen(function* () {
    const db = yield* Database;
    const access = yield* VaultAccessService;
    const storage = yield* ContentStorage;
    const stagedStorage = yield* StagedStorage;
    const mailer = yield* Mailer;
    const logger = yield* StructuredLogger;

    const getVaultRow = (vaultId: Uuid) =>
      Effect.gen(function* () {
        const rows = yield* db.query((d) => d
          .select()
          .from(vaults)
          .where(eq(vaults.id, vaultId))
          .limit(1));
        return rows[0];
      });

    // Session shares reference sessions polymorphically (subject_kind/subject_id),
    // so the vault cascade never reaches them; reference shares are user-scoped
    // and survive vault deletion.
    const deleteVaultRows = (vaultId: Uuid) =>
      db.transaction((tx) =>
        Effect.gen(function* () {
          const sessionRows = yield* tx
            .select({ id: sessions.id })
            .from(sessions)
            .where(eq(sessions.vaultId, vaultId));
          if (sessionRows.length > 0) {
            yield* tx
              .delete(shares)
              .where(
                and(
                  eq(shares.subjectKind, "session"),
                  inArray(shares.subjectId, sessionRows.map((row) => uuidOf(row.id))),
                ),
              );
          }
          yield* tx.delete(vaults).where(and(eq(vaults.id, vaultId), isNotNull(vaults.deletedAt)));
        }),
      );

    const finishVaultDeletion = (vaultId: Uuid) =>
      Effect.gen(function* () {
        yield* storage.clear(vaultOwner(vaultId));
        yield* stagedStorage.clearStagedVault(vaultId);
        yield* deleteVaultRows(vaultId);
      });

    const finishAccountDeletion = (userId: Uuid) =>
      Effect.gen(function* () {
        const owned = yield* db.query((d) =>
          d
            .select({ id: vaults.id })
            .from(vaults)
            .where(and(eq(vaults.ownerId, userId), isNotNull(vaults.deletedAt))),
        );
        yield* Effect.forEach(owned, (vault) => finishVaultDeletion(vault.id), { discard: true });
        yield* storage.clear(userOwner(userId));
        yield* db.query((d) =>
          d
            .delete(users)
            .where(
              and(
                eq(users.id, userId),
                isNotNull(users.deletedAt),
                notExists(
                  d.select({ id: vaults.id }).from(vaults).where(eq(vaults.ownerId, userId)),
                ),
              ),
            ),
        );
      });

    const deferCleanup =
      (event: string, fields: Record<string, string>) => (cause: Cause.Cause<unknown>) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : logger.warn(event, { ...fields, error_message: Cause.pretty(cause) });

    const ensureConfig = (vaultId: Uuid) =>
      Effect.gen(function* () {
        const owner = vaultOwner(vaultId);
        const exists = yield* storage.exists(owner, VAULT_CONFIG_PATH);
        if (!exists) {
          yield* storage.writeText(owner, VAULT_CONFIG_PATH, defaultVaultConfigText);
        }
      });

    const applyConfigUpdate = (vaultId: Uuid, input: VaultConfigUpdate) =>
      Effect.gen(function* () {
        const owner = vaultOwner(vaultId);
        const existing = yield* Effect.result(storage.readText(owner, VAULT_CONFIG_PATH));
        const doc = parseDocument(
          existing._tag === "Success" ? existing.success : defaultVaultConfigText,
        );
        if (input.thematic_hint !== undefined) {
          doc.set("thematic_hint", input.thematic_hint);
        }
        if (input.kinds !== undefined) {
          doc.set("kinds", [...input.kinds]);
        }
        yield* storage.writeText(owner, VAULT_CONFIG_PATH, String(doc));
      });

    const readConfig = (vaultId: Uuid) =>
      readVaultConfig(storage, vaultId).pipe(
        Effect.map((config): VaultConfig => ({
          thematic_hint: config.thematicHint,
          kinds: config.kinds,
        })),
        Effect.catchTag("VaultConfigMalformed", Effect.die),
      );

    const ensureUser = (emailInput: Email) =>
      Effect.gen(function* () {
        const email = normalizeEmail(emailInput);
        const inserted = yield* db.query((d) => d
          .insert(users)
          .values({ id: Uuid.make(randomUUID(), { disableChecks: true }), email })
          .onConflictDoNothing({ target: users.email })
          .returning());
        const row =
          inserted[0] ??
          (yield* db.query((d) => d.select().from(users).where(eq(users.email, email)).limit(1)))[0];
        if (row === undefined) {
          throw new Error(`user ${email} was not created or found`);
        }
        return row;
      });

    const createVault = (
      userId: Uuid,
      input: {
        readonly name: string;
        readonly thematic_hint?: string;
        readonly kinds?: readonly string[];
      },
    ) =>
      Effect.gen(function* () {
        const vaultId = Uuid.make(randomUUID(), { disableChecks: true });
        yield* ensureConfig(vaultId);
        if (input.thematic_hint !== undefined || input.kinds !== undefined) {
          const update: VaultConfigUpdate =
            input.kinds === undefined
              ? { thematic_hint: input.thematic_hint }
              : {
                  thematic_hint: input.thematic_hint,
                  kinds: [...input.kinds],
                };
          yield* applyConfigUpdate(vaultId, update);
        }
        const created = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const rows = yield* tx
                .insert(vaults)
                .values({
                  id: vaultId,
                  name: input.name,
                  ownerId: userId,
                })
                .returning();
              yield* tx.insert(vaultMemberships).values({
                id: Uuid.make(randomUUID(), { disableChecks: true }),
                vaultId,
                userId,
                role: "EDITOR",
              });
              const row = rows[0];
              if (row === undefined) {
                throw new Error("vault insert returned no row");
              }
              return row;
            }),
          )
          .pipe(
            Effect.catchCause((cause) =>
              logger
                .error("vault_create_db_failed_after_storage_seed", {
                  vault_id: vaultId,
                  error: "Cause",
                  error_message: Cause.pretty(cause),
                })
                .pipe(Effect.andThen(Effect.failCause(cause))),
            ),
          );
        return vaultResponse(created);
      });

    return {
      ensureDefaultForUser: (userId, email) =>
        Effect.gen(function* () {
          const membershipCounts = yield* db.query((d) =>
            d
              .select({ count: sql<number>`count(*)::int` })
              .from(vaultMemberships)
              .innerJoin(vaults, eq(vaults.id, vaultMemberships.vaultId))
              .where(and(eq(vaultMemberships.userId, userId), isNull(vaults.deletedAt))),
          );
          if (oneCount(membershipCounts) > 0) {
            return;
          }
          yield* createVault(userId, { name: `${email}'s vault` });
        }),
      deleteAccount: (userId) =>
        Effect.gen(function* () {
          yield* db.transaction((tx) =>
            Effect.gen(function* () {
              const marked = yield* tx
                .update(users)
                .set({ deletedAt: sql`coalesce(${users.deletedAt}, now())` })
                .where(eq(users.id, userId))
                .returning({ id: users.id });
              if (marked[0] === undefined) {
                return yield* new NotFound({ detail: "User not found" });
              }
              yield* tx
                .update(vaults)
                .set({ deletedAt: sql`coalesce(${vaults.deletedAt}, now())` })
                .where(eq(vaults.ownerId, userId));
            }),
          );
          yield* finishAccountDeletion(userId).pipe(
            Effect.catchCause(
              deferCleanup("account_deletion.cleanup_deferred", { user_id: userId }),
            ),
          );
        }),
      reconcileDeletionsOnce: () =>
        Effect.gen(function* () {
          const deletedVaults = yield* db.query((d) =>
            d
              .select({ id: vaults.id })
              .from(vaults)
              .where(isNotNull(vaults.deletedAt))
              .orderBy(asc(vaults.deletedAt))
              .limit(100),
          );
          yield* Effect.forEach(
            deletedVaults,
            (vault) =>
              finishVaultDeletion(vault.id).pipe(
                Effect.catchCause(
                  deferCleanup("vault_deletion.reconciliation_deferred", { vault_id: vault.id }),
                ),
              ),
            { discard: true },
          );
          const deletedUsers = yield* db.query((d) =>
            d
              .select({ id: users.id })
              .from(users)
              .where(isNotNull(users.deletedAt))
              .orderBy(asc(users.deletedAt))
              .limit(100),
          );
          yield* Effect.forEach(
            deletedUsers,
            (user) =>
              finishAccountDeletion(user.id).pipe(
                Effect.catchCause(
                  deferCleanup("account_deletion.reconciliation_deferred", { user_id: user.id }),
                ),
              ),
            { discard: true },
          );
          return deletedVaults.length + deletedUsers.length;
        }),
      createVault,
      listVaults: (userId, params) =>
        Effect.gen(function* () {
          const visible = and(eq(vaultMemberships.userId, userId), isNull(vaults.deletedAt));
          const countRows = yield* db.query((d) =>
            d
              .select({ total: sql<number>`count(*)::int` })
              .from(vaultMemberships)
              .innerJoin(vaults, eq(vaults.id, vaultMemberships.vaultId))
              .where(visible),
          );
          const rows = yield* db.query((d) =>
            d
              .select({
                id: vaults.id,
                name: vaults.name,
                ownerId: vaults.ownerId,
                createdAt: vaults.createdAt,
                role: vaultMemberships.role,
              })
              .from(vaultMemberships)
              .innerJoin(vaults, eq(vaults.id, vaultMemberships.vaultId))
              .where(visible)
              .orderBy(desc(vaults.createdAt))
              .limit(params.limit)
              .offset(params.offset),
          );

          return {
            ...pageEnvelope(
              rows.map((row) => vaultResponse(row)),
              params,
              oneTotal(countRows),
            ),
            roles: Object.fromEntries(
              rows.map((row) => [row.id, memberRole(row.ownerId, userId, row.role)]),
            ),
          };
        }),
      getVaultDetail: (userId, vaultId) =>
        Effect.gen(function* () {
          const scope = yield* access.requireMember(userId, vaultId, "Not a member of this vault");
          const rows = yield* db.query((d) => d
            .select()
            .from(vaults)
            .where(eq(vaults.id, vaultId))
            .limit(1));
          const vault = rows[0];
          if (vault === undefined) {
            return yield* new Forbidden({ detail: "Not a member of this vault" });
          }
          const memberCounts = yield* db.query((d) => d
            .select({ total: sql<number>`count(*)::int` })
            .from(vaultMemberships)
            .where(eq(vaultMemberships.vaultId, vaultId)));
          const articleCounts = yield* db.query((d) =>
            d
              .select({ total: sql<number>`count(*)::int` })
              .from(wikiArticles)
              .where(and(...liveArticleConditions(vaultId))),
          );
          return {
            ...vaultResponse(vault),
            role: scope.role,
            member_count: oneTotal(memberCounts),
            article_count: oneTotal(articleCounts),
          };
        }),
      renameVault: (userId, vaultId, input) =>
        db.transaction((tx) =>
          Effect.gen(function* () {
            yield* lockOwnedVault(tx, userId, vaultId);
            yield* tx.update(vaults).set({ name: input.name }).where(eq(vaults.id, vaultId));
          }),
        ),
      getVaultConfig: (userId, vaultId) =>
        Effect.gen(function* () {
          yield* access.requireMember(userId, vaultId);
          return yield* readConfig(vaultId);
        }),
      updateVaultConfig: (userId, vaultId, input) =>
        Effect.gen(function* () {
          yield* access.requireOwner(userId, vaultId);
          yield* applyConfigUpdate(vaultId, input);
          return yield* readConfig(vaultId);
        }),
      listMembers: (userId, vaultId, params) =>
        Effect.gen(function* () {
          yield* access.requireOwner(userId, vaultId);
          const countRows = yield* db.query((d) => d
            .select({ total: sql<number>`count(*)::int` })
            .from(vaultMemberships)
            .where(eq(vaultMemberships.vaultId, vaultId)));
          const rows = yield* db.query((d) =>
            d
              .select({
                userId: vaultMemberships.userId,
                role: vaultMemberships.role,
                email: users.email,
                ownerId: vaults.ownerId,
              })
              .from(vaultMemberships)
              .innerJoin(users, eq(users.id, vaultMemberships.userId))
              .innerJoin(vaults, eq(vaults.id, vaultMemberships.vaultId))
              .where(eq(vaultMemberships.vaultId, vaultId))
              .orderBy(desc(eq(vaultMemberships.userId, vaults.ownerId)), asc(users.email))
              .limit(params.limit)
              .offset(params.offset),
          );
          return pageEnvelope(rows.map(memberResponse), params, oneTotal(countRows));
        }),
      inviteMember: (userId, vaultId, input) =>
        Effect.gen(function* () {
          yield* access.requireOwner(userId, vaultId);
          const vault = yield* getVaultRow(vaultId);
          if (vault === undefined) {
            return yield* new Forbidden({ detail: "Only vault owners can perform this action" });
          }
          const inviterRows = yield* db.query((d) => d
            .select({ email: users.email })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1));
          const inviterEmail = inviterRows[0]?.email ?? "";
          const role = input.role ?? "editor";
          const target = yield* ensureUser(input.email);
          if (target.deletedAt !== null) return yield* accountBeingDeleted();
          yield* db.query((d) => d
            .insert(vaultMemberships)
            .values({
              id: Uuid.make(randomUUID(), { disableChecks: true }),
              vaultId,
              userId: target.id,
              role: roleToDb(role),
            })
            .onConflictDoNothing({
              target: [vaultMemberships.vaultId, vaultMemberships.userId],
            }));
          yield* mailer
            .send({
              to: target.email,
              subject: `You've been invited to ${vault.name}`,
              body:
                `${inviterEmail} invited you to the project "${vault.name}" ` +
                `on Great Minds as ${role}.\n\n` +
                "Sign in at https://greatmind.dev to access it.",
            })
            .pipe(
              Effect.catchCause((cause) =>
                logger
                  .error("vault_member_invite_email_failed", {
                    vault_id: vaultId,
                    email: target.email,
                    role,
                    error_message: Cause.pretty(cause),
                  })
                  .pipe(Effect.andThen(Effect.failCause(cause))),
              ),
            );
          return {
            user_id: target.id,
            email: asEmail(target.email),
            role,
          };
        }),
      updateMemberRole: (userId, vaultId, memberUserId, role) =>
        db.transaction((tx) =>
          Effect.gen(function* () {
            const vault = yield* lockOwnedVault(tx, userId, vaultId);
            if (memberUserId === vault.ownerId) {
              return yield* new BadRequest({
                detail: "The vault owner's role changes only through ownership transfer",
              });
            }
            const userRows = yield* tx
              .select({ id: users.id, email: users.email })
              .from(users)
              .where(eq(users.id, memberUserId))
              .limit(1);
            const target = userRows[0];
            if (target === undefined) {
              return yield* new NotFound({ detail: "User not found" });
            }
            const updated = yield* tx
              .update(vaultMemberships)
              .set({ role: roleToDb(role) })
              .where(
                and(
                  eq(vaultMemberships.vaultId, vaultId),
                  eq(vaultMemberships.userId, memberUserId),
                ),
              )
              .returning({ role: vaultMemberships.role });
            const row = updated[0];
            if (row === undefined) {
              return yield* new NotFound({ detail: "User is not a member of this vault" });
            }
            return {
              user_id: target.id,
              email: asEmail(target.email),
              role: roleFromDb(row.role),
            };
          }),
        ),
      removeMember: (userId, vaultId, memberUserId) =>
        db.transaction((tx) =>
          Effect.gen(function* () {
            const vault = yield* lockOwnedVault(tx, userId, vaultId);
            if (memberUserId === vault.ownerId) {
              return yield* new BadRequest({
                detail: "The vault owner cannot be removed; transfer ownership first",
              });
            }
            const deleted = yield* tx
              .delete(vaultMemberships)
              .where(
                and(
                  eq(vaultMemberships.vaultId, vaultId),
                  eq(vaultMemberships.userId, memberUserId),
                ),
              )
              .returning({ id: vaultMemberships.id });
            if (deleted[0] === undefined) {
              return yield* new NotFound({ detail: "Membership not found" });
            }
          }),
        ),
      transferOwnership: (userId, vaultId, input) =>
        db.transaction((tx) =>
          Effect.gen(function* () {
            const vault = yield* lockOwnedVault(tx, userId, vaultId);
            if (input.new_owner_user_id === vault.ownerId) {
              return yield* new BadRequest({
                detail: "Cannot transfer ownership to the current owner",
              });
            }
            yield* lockTransferTarget(tx, vaultId, input.new_owner_user_id);
            yield* tx
              .update(vaults)
              .set({ ownerId: input.new_owner_user_id })
              .where(eq(vaults.id, vaultId));
            yield* tx
              .update(vaultMemberships)
              .set({ role: "EDITOR" })
              .where(
                and(
                  eq(vaultMemberships.vaultId, vaultId),
                  eq(vaultMemberships.userId, vault.ownerId),
                ),
              );
          }),
        ),
      deleteVault: (userId, vaultId) =>
        Effect.gen(function* () {
          yield* db.transaction((tx) =>
            Effect.gen(function* () {
              const [vault] = yield* tx
                .select({ ownerId: vaults.ownerId })
                .from(vaults)
                .where(eq(vaults.id, vaultId))
                .for("no key update");
              if (vault === undefined) return yield* new NotFound({ detail: "Vault not found" });
              if (vault.ownerId !== userId) return yield* ownerOnly();
              yield* tx
                .update(vaults)
                .set({ deletedAt: sql`coalesce(${vaults.deletedAt}, now())` })
                .where(eq(vaults.id, vaultId));
            }),
          );
          yield* finishVaultDeletion(vaultId).pipe(
            Effect.catchCause(
              deferCleanup("vault_deletion.cleanup_deferred", { vault_id: vaultId }),
            ),
          );
        }),
    } satisfies VaultsServiceShape;
  }),
);

export const DeletionReconcilerLoopLive = Layer.effectDiscard(
  Effect.flatMap(VaultsService, (service) =>
    backgroundLoop({
      failureEvent: "deletion.reconciler_tick_failed",
      interval: "1 minute",
      tick: service.reconcileDeletionsOnce(),
    }),
  ),
);
