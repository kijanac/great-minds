import { randomUUID } from "node:crypto";

import { Database, sessions, shares, users, vaultMemberships, vaults, wikiArticles } from "@great-minds/database";
import {
  BadRequest,
  Email,
  Forbidden,
  type InvitedMemberRole,
  type MemberPage,
  type MemberRole,
  type MemberWithEmail,
  NotFound,
  type OwnershipTransfer,
  type PageParams,
  type Uuid,
  type Vault,
  type VaultConfig,
  type VaultConfigUpdate,
  type VaultDetail,
  type VaultPage,
} from "@great-minds/domain";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { Cause, Context, Effect, Layer, Schema } from "effect";
import { parse as parseYaml, parseDocument } from "yaml";

import { StructuredLogger } from "./logging.ts";
import { Mailer } from "./mailer.ts";
import { pageEnvelope, oneTotal } from "./pagination.ts";
import { ContentStorage, StagedStorage, vaultOwner } from "./storage.ts";

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
  readonly deleteOwnedVaults: (userId: Uuid) => Effect.Effect<void>;
  readonly createVault: (
    userId: Uuid,
    input: { readonly name: string; readonly thematic_hint?: string; readonly kinds?: readonly string[] },
  ) => Effect.Effect<Vault>;
  readonly listVaults: (userId: Uuid, params: PageParams) => Effect.Effect<VaultPage>;
  readonly getVaultDetail: (userId: Uuid, vaultId: Uuid) => Effect.Effect<VaultDetail, Forbidden>;
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
    input: { readonly email: Email; readonly role?: InvitedMemberRole },
  ) => Effect.Effect<MemberWithEmail, Forbidden>;
  readonly updateMemberRole: (
    userId: Uuid,
    vaultId: Uuid,
    memberUserId: Uuid,
    role: MemberRole,
  ) => Effect.Effect<MemberWithEmail, Forbidden | NotFound>;
  readonly removeMember: (
    userId: Uuid,
    vaultId: Uuid,
    memberUserId: Uuid,
  ) => Effect.Effect<void, Forbidden | NotFound>;
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

const defaultVaultConfig = {
  thematic_hint: "",
  kinds: ["person", "event", "organization", "concept"],
} satisfies VaultConfig;

const CONFIG_PATH = "config.yaml";

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

const VaultConfigYaml = Schema.Struct({
  thematic_hint: Schema.optionalKey(Schema.NullOr(Schema.String)),
  kinds: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
});

const decodeVaultConfigYaml = Schema.decodeUnknownEffect(VaultConfigYaml);

const parseVaultConfig = (content: string) =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => parseYaml(content) as unknown,
      catch: (error) => error,
    }).pipe(Effect.orDie);
    const decoded = yield* decodeVaultConfigYaml(parsed ?? {}).pipe(Effect.orDie);
    return {
      thematic_hint: decoded.thematic_hint ?? defaultVaultConfig.thematic_hint,
      kinds:
        decoded.kinds !== undefined && decoded.kinds !== null && decoded.kinds.length > 0
          ? decoded.kinds
          : defaultVaultConfig.kinds,
    } satisfies VaultConfig;
  });

const asUuid = (value: string): Uuid => value as Uuid;

const asEmail = (value: string): Email => value as Email;

const normalizeEmail = (email: Email) => asEmail(email.trim().toLowerCase());

const roleFromDb = (role: DbMemberRole): MemberRole => {
  switch (role) {
    case "OWNER":
      return "owner";
    case "EDITOR":
      return "editor";
    case "VIEWER":
      return "viewer";
  }
};

const roleToDb = (role: MemberRole | InvitedMemberRole): DbMemberRole => {
  switch (role) {
    case "owner":
      return "OWNER";
    case "editor":
      return "EDITOR";
    case "viewer":
      return "VIEWER";
  }
};

const vaultResponse = (row: {
  readonly id: string;
  readonly name: string;
  readonly ownerId: string;
  readonly createdAt: Date;
}) => ({
  id: asUuid(row.id),
  name: row.name,
  owner_id: asUuid(row.ownerId),
  created_at: row.createdAt.toISOString(),
});

const memberResponse = (row: {
  readonly userId: string;
  readonly email: string;
  readonly role: DbMemberRole;
}): MemberWithEmail => ({
  user_id: asUuid(row.userId),
  email: asEmail(row.email),
  role: roleFromDb(row.role),
});

const oneCount = (rows: readonly CountRow[]) => {
  const row = rows[0];
  if (row === undefined) {
    throw new Error("count query returned no rows");
  }
  return row.count;
};

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
        const rows = yield* db.query((d) => d
          .select({ role: vaultMemberships.role })
          .from(vaultMemberships)
          .where(and(eq(vaultMemberships.userId, userId), eq(vaultMemberships.vaultId, vaultId)))
          .limit(1));
        const row = rows[0];
        if (row === undefined) {
          return yield* new Forbidden({ detail });
        }
        return {
          vaultId,
          userId,
          role: roleFromDb(row.role),
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
          if (scope.role !== "owner") {
            return yield* new Forbidden({
              detail: "Only vault owners can perform this action",
            });
          }
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
    const deleteVaultRows = (vaultIds: readonly string[]) =>
      db.transaction((tx) =>
        Effect.gen(function* () {
          const sessionRows = yield* tx
            .select({ id: sessions.id })
            .from(sessions)
            .where(inArray(sessions.vaultId, vaultIds));
          if (sessionRows.length > 0) {
            yield* tx
              .delete(shares)
              .where(
                and(
                  eq(shares.subjectKind, "session"),
                  inArray(shares.subjectId, sessionRows.map((row) => row.id)),
                ),
              );
          }
          yield* tx.delete(vaults).where(inArray(vaults.id, vaultIds));
        }),
      );

    const ensureConfig = (vaultId: Uuid) =>
      Effect.gen(function* () {
        const owner = vaultOwner(vaultId);
        const exists = yield* storage.exists(owner, CONFIG_PATH);
        if (!exists) {
          yield* storage.writeText(owner, CONFIG_PATH, defaultVaultConfigText);
        }
      });

    const applyConfigUpdate = (vaultId: Uuid, input: VaultConfigUpdate) =>
      Effect.gen(function* () {
        const owner = vaultOwner(vaultId);
        const existing = yield* Effect.result(storage.readText(owner, CONFIG_PATH));
        const doc = parseDocument(
          existing._tag === "Success" ? existing.success : defaultVaultConfigText,
        );
        if (input.thematic_hint !== undefined) {
          doc.set("thematic_hint", input.thematic_hint);
        }
        if (input.kinds !== undefined) {
          doc.set("kinds", [...input.kinds]);
        }
        yield* storage.writeText(owner, CONFIG_PATH, String(doc));
      });

    const readConfig = (vaultId: Uuid) =>
      Effect.gen(function* () {
        const content = yield* Effect.result(storage.readText(vaultOwner(vaultId), CONFIG_PATH));
        if (content._tag === "Failure") {
          return defaultVaultConfig;
        }
        return yield* parseVaultConfig(content.success);
      });

    const ensureUser = (emailInput: Email) =>
      Effect.gen(function* () {
        const email = normalizeEmail(emailInput);
        const inserted = yield* db.query((d) => d
          .insert(users)
          .values({ id: randomUUID(), email })
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
        const vaultId = asUuid(randomUUID());
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
                id: randomUUID(),
                vaultId,
                userId,
                role: "OWNER",
              });
              const row = rows[0];
              if (row === undefined) {
                throw new Error("vault insert returned no row");
              }
              return row;
            }),
          )
          .pipe(Effect.catchCause((cause) =>
          logger
            .error("vault_create_db_failed_after_storage_seed", {
              vault_id: vaultId,
              error: "Cause",
              error_message: Cause.pretty(cause),
            })
            .pipe(Effect.andThen(Effect.failCause(cause))),
        ));
        return vaultResponse(created);
      });

    return {
      ensureDefaultForUser: (userId, email) =>
        Effect.gen(function* () {
          const membershipCounts = yield* db.query((d) => d
            .select({ count: sql<number>`count(*)::int` })
            .from(vaultMemberships)
            .where(eq(vaultMemberships.userId, userId)));
          if (oneCount(membershipCounts) > 0) {
            return;
          }
          yield* createVault(userId, { name: `${email}'s vault` });
        }),
      deleteOwnedVaults: (userId) =>
        Effect.gen(function* () {
          const owned = yield* db.query((d) => d
            .select({ id: vaults.id })
            .from(vaults)
            .where(eq(vaults.ownerId, userId)));
          if (owned.length === 0) {
            return;
          }
          // Storage first: a failed wipe leaves the vault intact and retryable,
          // never orphaned files with no DB handle.
          for (const vault of owned) {
            yield* storage.clear(vaultOwner(asUuid(vault.id)));
            yield* stagedStorage.clearStagedVault(asUuid(vault.id));
          }
          yield* deleteVaultRows(owned.map((vault) => vault.id));
        }),
      createVault,
      listVaults: (userId, params) =>
        Effect.gen(function* () {
          const countRows = yield* db.query((d) => d
            .select({ total: sql<number>`count(*)::int` })
            .from(vaultMemberships)
            .where(eq(vaultMemberships.userId, userId)));
          const rows = yield* db.query((d) => d
            .select({
              id: vaults.id,
              name: vaults.name,
              ownerId: vaults.ownerId,
              createdAt: vaults.createdAt,
              role: vaultMemberships.role,
            })
            .from(vaultMemberships)
            .innerJoin(vaults, eq(vaults.id, vaultMemberships.vaultId))
            .where(eq(vaultMemberships.userId, userId))
            .orderBy(desc(vaults.createdAt))
            .limit(params.limit)
            .offset(params.offset));

          return {
            ...pageEnvelope(
              rows.map((row) => vaultResponse(row)),
              params,
              oneTotal(countRows),
            ),
            roles: Object.fromEntries(rows.map((row) => [row.id, roleFromDb(row.role)])),
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
          const articleCounts = yield* db.query((d) => d
            .select({ total: sql<number>`count(*)::int` })
            .from(wikiArticles)
            .where(eq(wikiArticles.vaultId, vaultId)));
          return {
            ...vaultResponse(vault),
            role: scope.role,
            member_count: oneTotal(memberCounts),
            article_count: oneTotal(articleCounts),
          };
        }),
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
          const rows = yield* db.query((d) => d
            .select({
              userId: vaultMemberships.userId,
              role: vaultMemberships.role,
              email: users.email,
            })
            .from(vaultMemberships)
            .innerJoin(users, eq(users.id, vaultMemberships.userId))
            .where(eq(vaultMemberships.vaultId, vaultId))
            .orderBy(asc(users.email))
            .limit(params.limit)
            .offset(params.offset));
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
          yield* db.query((d) => d
            .insert(vaultMemberships)
            .values({
              id: randomUUID(),
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
            user_id: asUuid(target.id),
            email: asEmail(target.email),
            role,
          };
        }),
      updateMemberRole: (userId, vaultId, memberUserId, role) =>
        Effect.gen(function* () {
          yield* access.requireOwner(userId, vaultId);
          const userRows = yield* db.query((d) => d
            .select({ id: users.id, email: users.email })
            .from(users)
            .where(eq(users.id, memberUserId))
            .limit(1));
          const target = userRows[0];
          if (target === undefined) {
            return yield* new NotFound({ detail: "User not found" });
          }
          const updated = yield* db.query((d) => d
            .update(vaultMemberships)
            .set({ role: roleToDb(role) })
            .where(
              and(
                eq(vaultMemberships.vaultId, vaultId),
                eq(vaultMemberships.userId, memberUserId),
              ),
            )
            .returning({ role: vaultMemberships.role }));
          const row = updated[0];
          if (row === undefined) {
            return yield* new NotFound({ detail: "User is not a member of this vault" });
          }
          return {
            user_id: asUuid(target.id),
            email: asEmail(target.email),
            role: roleFromDb(row.role),
          };
        }),
      removeMember: (userId, vaultId, memberUserId) =>
        Effect.gen(function* () {
          yield* access.requireOwner(userId, vaultId);
          const deleted = yield* db.query((d) => d
            .delete(vaultMemberships)
            .where(
              and(
                eq(vaultMemberships.vaultId, vaultId),
                eq(vaultMemberships.userId, memberUserId),
              ),
            )
            .returning({ id: vaultMemberships.id }));
          if (deleted[0] === undefined) {
            return yield* new NotFound({ detail: "Membership not found" });
          }
        }),
      transferOwnership: (userId, vaultId, input) =>
        Effect.gen(function* () {
          yield* access.requireOwner(userId, vaultId);
          if (input.new_owner_user_id === userId) {
            return yield* new BadRequest({ detail: "Cannot transfer ownership to the current owner" });
          }
          const result = yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const newOwner = yield* tx
                  .update(vaultMemberships)
                  .set({ role: "OWNER" })
                  .where(
                    and(
                      eq(vaultMemberships.vaultId, vaultId),
                      eq(vaultMemberships.userId, input.new_owner_user_id),
                    ),
                  )
                  .returning({ id: vaultMemberships.id });
                if (newOwner[0] === undefined) {
                  return false;
                }
                yield* tx
                  .update(vaultMemberships)
                  .set({ role: "EDITOR" })
                  .where(
                    and(eq(vaultMemberships.vaultId, vaultId), eq(vaultMemberships.userId, userId)),
                  );
                yield* tx.update(vaults).set({ ownerId: input.new_owner_user_id }).where(eq(vaults.id, vaultId));
                return true;
              }),
            );
          if (!result) {
            return yield* new BadRequest({
              detail: `User ${input.new_owner_user_id} is not a member of vault ${vaultId}`,
            });
          }
        }),
      deleteVault: (userId, vaultId) =>
        Effect.gen(function* () {
          const vault = yield* getVaultRow(vaultId);
          if (vault === undefined) {
            return yield* new NotFound({ detail: "Vault not found" });
          }
          if (vault.ownerId !== userId) {
            return yield* new Forbidden({ detail: "Only vault owners can perform this action" });
          }
          // Storage first: a failed wipe leaves the vault intact and retryable,
          // never orphaned files with no DB handle.
          yield* storage.clear(vaultOwner(vaultId));
          yield* stagedStorage.clearStagedVault(vaultId);
          yield* deleteVaultRows([vaultId]);
        }),
    } satisfies VaultsServiceShape;
  }),
);
