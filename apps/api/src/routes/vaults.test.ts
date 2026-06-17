import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, test, vi, afterEach } from "vitest";
import {
  AuthService,
  QueryService,
  SourceService,
  StorageOperationFailed,
  sourceServiceLayer,
  VaultMemberAlreadyExists,
  VaultService,
  VaultStorage,
  vaultServiceLayer,
  type AuthenticatedPrincipal,
  type AuthConfigService,
  type VaultStorageService,
} from "@great-minds/core";
import { Db, type BackendDb } from "@great-minds/db/context";
import { sourceDocuments, vaults } from "@great-minds/db/schema";
import { UserSchema } from "@great-minds/domain/user";
import { VaultInternalSchema, VaultSchema } from "@great-minds/domain/vault";
import { createApp } from "../app.js";
import type { ApiConfig } from "../context.js";
import type { ApiRuntime } from "../runtime.js";

const userId = "11111111-1111-4111-8111-111111111111";
const vaultId = "22222222-2222-4222-8222-222222222222";
const memberUserId = "33333333-3333-4333-8333-333333333333";

const user = UserSchema.parse({
  id: userId,
  email: "owner@greatminds.local",
  createdAt: new Date("2026-01-01T00:00:00Z"),
});
const memberUser = UserSchema.parse({
  id: memberUserId,
  email: "member@greatminds.local",
  createdAt: new Date("2026-01-01T00:00:00Z"),
});
const vaultInternal = VaultInternalSchema.parse({
  id: vaultId,
  ownerId: userId,
  name: "Test Vault",
  storageBucketName: "gm-owner",
  thematicHint: "",
  kinds: ["person", "event", "organization", "concept"],
  createdAt: new Date("2026-01-01T00:00:00Z"),
});
const vault = VaultSchema.parse(vaultInternal);

const principal: AuthenticatedPrincipal = { user, credential: { kind: "session" } };

const baseAuthConfig: AuthConfigService = {
  jwtSecret: "test-secret-test-secret-test-secret-test-secret",
  jwtAccessExpiryMinutes: 15,
  jwtRefreshExpiryDays: 30,
  authCodeExpiryMinutes: 10,
};

const baseConfig: ApiConfig = {
  auth: baseAuthConfig,
  authCodeDelivery: { kind: "console" },
  openAiProvider: { kind: "disabled" },
  storage: { kind: "local", dataDir: "/tmp/great-minds-test" },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("vault member routes", () => {
  test("invites a new member and sends email", async () => {
    const fetch = vi.fn(
      (
        _input: Parameters<typeof globalThis.fetch>[0],
        _init?: Parameters<typeof globalThis.fetch>[1],
      ) => Promise.resolve(Response.json({ id: "email_123" })),
    );
    vi.stubGlobal("fetch", fetch);
    const app = createApp(
      runtimeWithMockVaultService({
        getVault: () => Effect.succeed(vault),
        inviteMember: () =>
          Effect.succeed({ user: { id: memberUser.id, email: memberUser.email }, role: "editor" }),
      }),
      {
        ...baseConfig,
        authCodeDelivery: {
          kind: "resend",
          apiKey: "re_test",
          fromEmail: "Great Minds <hello@greatminds.local>",
        },
      },
    );

    const response = await app.request(`/v1/vaults/${vaultId}/members`, {
      method: "POST",
      headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      body: JSON.stringify({ email: memberUser.email, role: "editor" }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      user: { id: memberUser.id, email: memberUser.email },
      role: "editor",
    });
    expect(fetch).toHaveBeenCalledOnce();
    const [, init] = fetch.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toMatchObject({
      to: [memberUser.email],
      subject: "You've been invited to Test Vault",
    });
  });

  test("rejects duplicate member invites without sending email", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const app = createApp(
      runtimeWithMockVaultService({
        getVault: () => Effect.succeed(vault),
        inviteMember: () =>
          Effect.fail(
            new VaultMemberAlreadyExists({ message: "User is already a member of this vault" }),
          ),
      }),
      {
        ...baseConfig,
        authCodeDelivery: {
          kind: "resend",
          apiKey: "re_test",
          fromEmail: "Great Minds <hello@greatminds.local>",
        },
      },
    );

    const response = await app.request(`/v1/vaults/${vaultId}/members`, {
      method: "POST",
      headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      body: JSON.stringify({ email: memberUser.email, role: "editor" }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { message: "User is already a member of this vault" },
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("source routes", () => {
  test("writes markdown source content and indexes metadata", async () => {
    const written: Array<{ path: string; content: string }> = [];
    const app = createApp(
      runtimeWithRealSourceService({
        db: fakeCreateSourceDb(),
        storage: {
          prepareBucketForOwner: () => Effect.succeed(null),
          writeText: (_vault, filePath, content) => {
            written.push({ path: filePath, content });
            return Effect.succeed({ etag: "etag-source" });
          },
          deleteText: () => Effect.void,
          clearVault: () => Effect.void,
        },
      }),
      baseConfig,
    );

    const response = await app.request(`/v1/vaults/${vaultId}/sources`, {
      method: "POST",
      headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      body: JSON.stringify({
        destPath: "notes/example.txt",
        content: "Hello source",
        origin: "manual",
      }),
    });

    expect(response.status).toBe(200);
    expect(written).toEqual([
      {
        path: "raw/docs/notes/example.md",
        content: '---\nsource_type: "document"\norigin: "manual"\n---\nHello source',
      },
    ]);
    expect(await response.json()).toMatchObject({
      filePath: "raw/docs/notes/example.md",
      sourceType: "document",
      origin: "manual",
      etag: "etag-source",
    });
  });

  test("deletes source metadata and storage without compile intent", async () => {
    const deleteText = vi.fn((_vault: typeof vaultInternal, _filePath: string) => Effect.void);
    const app = createApp(
      runtimeWithRealSourceService({
        db: fakeDeleteSourceDb(),
        storage: {
          prepareBucketForOwner: () => Effect.succeed(null),
          writeText: () => Effect.succeed({ etag: null }),
          deleteText,
          clearVault: () => Effect.void,
        },
      }),
      baseConfig,
    );

    const response = await app.request(
      `/v1/vaults/${vaultId}/sources?filePath=${encodeURIComponent("raw/docs/notes/example.md")}`,
      {
        method: "DELETE",
        headers: { Authorization: "Bearer test" },
      },
    );

    expect(response.status).toBe(204);
    expect(deleteText).toHaveBeenCalledOnce();
    expect(deleteText.mock.calls[0]).toEqual([vaultInternal, "raw/docs/notes/example.md"]);
  });
});

describe("vault storage routes", () => {
  test("creates vaults with computed storage bucket names", async () => {
    const insertedVaults: unknown[] = [];
    const app = createApp(
      runtimeWithRealVaultService({
        db: fakeCreateVaultDb(insertedVaults),
        storage: {
          prepareBucketForOwner: () => Effect.succeed("gm-computed"),
          writeText: () => Effect.succeed({ etag: null }),
          deleteText: () => Effect.void,
          clearVault: () => Effect.void,
        },
      }),
      baseConfig,
    );

    const response = await app.request("/v1/vaults", {
      method: "POST",
      headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Created Vault",
        thematicHint: "hint",
        storageBucketName: "client-supplied",
      }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { vault: Record<string, unknown> };
    expect(body).toMatchObject({ vault: { name: "Created Vault" } });
    expect(body.vault).not.toHaveProperty("storageBucketName");
    expect(insertedVaults[0]).toMatchObject({ storageBucketName: "gm-computed" });
  });

  test("clears storage after deleting a vault", async () => {
    const clearVault = vi.fn((_vault: typeof vaultInternal) => Effect.void);
    const app = createApp(
      runtimeWithRealVaultService({
        db: fakeDeleteVaultDb(),
        storage: {
          prepareBucketForOwner: () => Effect.succeed(null),
          writeText: () => Effect.succeed({ etag: null }),
          deleteText: () => Effect.void,
          clearVault,
        },
      }),
      baseConfig,
    );

    const response = await app.request(`/v1/vaults/${vaultId}`, {
      method: "DELETE",
      headers: { Authorization: "Bearer test" },
    });

    expect(response.status).toBe(204);
    expect(clearVault).toHaveBeenCalledOnce();
    expect(clearVault.mock.calls[0]?.[0]).toMatchObject({
      id: vault.id,
      storageBucketName: vaultInternal.storageBucketName,
    });
  });

  test("maps storage cleanup failures after vault delete", async () => {
    const app = createApp(
      runtimeWithRealVaultService({
        db: fakeDeleteVaultDb(),
        storage: {
          prepareBucketForOwner: () => Effect.succeed(null),
          writeText: () => Effect.succeed({ etag: null }),
          deleteText: () => Effect.void,
          clearVault: () =>
            Effect.fail(
              new StorageOperationFailed({
                operation: "clearVault",
                message: "Failed to clear vault storage",
              }),
            ),
        },
      }),
      baseConfig,
    );

    const response = await app.request(`/v1/vaults/${vaultId}`, {
      method: "DELETE",
      headers: { Authorization: "Bearer test" },
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: { message: "Failed to clear vault storage" },
    });
  });
});

type VaultServiceShape = Parameters<typeof VaultService.of>[0];

function runtimeWithMockVaultService(overrides: Partial<VaultServiceShape>): ApiRuntime {
  return ManagedRuntime.make(
    Layer.mergeAll(
      authLayer,
      Layer.succeed(VaultService, VaultService.of({ ...unusedVaultService, ...overrides })),
      Layer.succeed(
        QueryService,
        QueryService.of({ answer: () => Effect.die("unused query service") }),
      ),
      Layer.succeed(
        SourceService,
        SourceService.of({
          listSources: () => Effect.die("unused source service"),
          createSourceDocument: () => Effect.die("unused source service"),
          deleteSourceDocument: () => Effect.die("unused source service"),
        }),
      ),
    ),
  );
}

function runtimeWithRealVaultService({
  db,
  storage,
}: {
  db: BackendDb;
  storage: VaultStorageService;
}): ApiRuntime {
  return ManagedRuntime.make(
    Layer.mergeAll(
      authLayer,
      vaultServiceLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(Db, db),
            Layer.succeed(VaultStorage, VaultStorage.of(storage)),
          ),
        ),
      ),
      Layer.succeed(
        QueryService,
        QueryService.of({ answer: () => Effect.die("unused query service") }),
      ),
      Layer.succeed(
        SourceService,
        SourceService.of({
          listSources: () => Effect.die("unused source service"),
          createSourceDocument: () => Effect.die("unused source service"),
          deleteSourceDocument: () => Effect.die("unused source service"),
        }),
      ),
    ),
  );
}

function runtimeWithRealSourceService({
  db,
  storage,
}: {
  db: BackendDb;
  storage: VaultStorageService;
}): ApiRuntime {
  return ManagedRuntime.make(
    Layer.mergeAll(
      authLayer,
      sourceServiceLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(Db, db),
            Layer.succeed(VaultStorage, VaultStorage.of(storage)),
          ),
        ),
      ),
      Layer.succeed(
        QueryService,
        QueryService.of({ answer: () => Effect.die("unused query service") }),
      ),
      Layer.succeed(VaultService, VaultService.of(unusedVaultService)),
    ),
  );
}

const authLayer = Layer.succeed(
  AuthService,
  AuthService.of({
    requestCode: () => Effect.die("unused auth service"),
    verifyCode: () => Effect.die("unused auth service"),
    refreshTokens: () => Effect.die("unused auth service"),
    resolveBearerToken: () => Effect.succeed(principal),
    createApiKey: () => Effect.die("unused auth service"),
    listApiKeys: () => Effect.die("unused auth service"),
    revokeApiKey: () => Effect.die("unused auth service"),
  }),
);

const unusedVaultService: VaultServiceShape = {
  listVaults: () => Effect.die("unused vault service"),
  createVault: () => Effect.die("unused vault service"),
  getVault: () => Effect.die("unused vault service"),
  updateVault: () => Effect.die("unused vault service"),
  deleteVault: () => Effect.die("unused vault service"),
  listMembers: () => Effect.die("unused vault service"),
  inviteMember: () => Effect.die("unused vault service"),
  updateMember: () => Effect.die("unused vault service"),
  removeMember: () => Effect.die("unused vault service"),
  getStats: () => Effect.die("unused vault service"),
};

function fakeCreateVaultDb(insertedVaults: unknown[]): BackendDb {
  const db = {
    transaction: (program: (tx: BackendDb) => Effect.Effect<unknown, unknown, never>) =>
      program(db as unknown as BackendDb),
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        const objectValues = values as Record<string, unknown>;
        if (table === vaults) insertedVaults.push(objectValues);
        return {
          returning: () =>
            table === vaults
              ? Effect.succeed([{ ...vault, ...objectValues, id: vaultId, ownerId: userId }])
              : Effect.succeed([]),
          pipe: (fn: (effect: Effect.Effect<unknown>) => Effect.Effect<unknown>) => fn(Effect.void),
        };
      },
    }),
    select: () =>
      chain([
        { user, vault: { ...vault, name: "Created Vault", storageBucketName: "gm-computed" } },
      ]),
  };
  return db as unknown as BackendDb;
}

function fakeDeleteVaultDb(): BackendDb {
  const db = {
    transaction: (program: (tx: BackendDb) => Effect.Effect<unknown, unknown, never>) =>
      program(db as unknown as BackendDb),
    select: (selection?: Record<string, unknown>) =>
      selection && "role" in selection
        ? chain([{ role: "owner" }])
        : chain([{ vault: vaultInternal }]),
    delete: (table: unknown) => ({
      where: () => ({
        returning: () =>
          table === vaults ? Effect.succeed([{ id: vaultId }]) : Effect.succeed([]),
      }),
    }),
  };
  return db as unknown as BackendDb;
}

function fakeCreateSourceDb(): BackendDb {
  const db = {
    select: () => chain([{ vault: vaultInternal }]),
    insert: (table: unknown) => ({
      values: (values: unknown) => ({
        onConflictDoUpdate: () => ({
          returning: () =>
            table === sourceDocuments
              ? Effect.succeed([sourceDocumentRow(values as Record<string, unknown>)])
              : Effect.succeed([]),
        }),
      }),
    }),
  };
  return db as unknown as BackendDb;
}

function fakeDeleteSourceDb(): BackendDb {
  const db = {
    transaction: (program: (tx: BackendDb) => Effect.Effect<unknown, unknown, never>) =>
      program(db as unknown as BackendDb),
    select: (selection?: Record<string, unknown>) =>
      selection && "role" in selection
        ? chain([{ role: "owner" }])
        : chain([{ vault: vaultInternal }]),
    delete: (table: unknown) => ({
      where: () => ({
        returning: () =>
          table === sourceDocuments
            ? Effect.succeed([{ id: "44444444-4444-4444-8444-444444444444" }])
            : Effect.succeed([]),
      }),
    }),
  };
  return db as unknown as BackendDb;
}

function sourceDocumentRow(values: Record<string, unknown>) {
  const now = new Date("2026-01-01T00:00:00Z");
  return {
    id: "44444444-4444-4444-8444-444444444444",
    vaultId,
    filePath: values.filePath,
    fileHash: values.fileHash,
    bodyHash: values.bodyHash,
    clientHash: values.clientHash ?? null,
    etag: values.etag ?? null,
    sourceType: values.sourceType,
    url: values.url ?? null,
    origin: values.origin ?? null,
    title: null,
    precis: null,
    author: null,
    publishedDate: null,
    genre: null,
    tags: [],
    derivedExtras: {},
    createdAt: now,
    updatedAt: values.updatedAt ?? now,
  };
}

function chain<T>(rows: T[]) {
  const query = {
    from: () => query,
    innerJoin: () => query,
    where: () => query,
    orderBy: () => Effect.succeed(rows),
    limit: () => Effect.succeed(rows.slice(0, 1)),
  };
  return query;
}
