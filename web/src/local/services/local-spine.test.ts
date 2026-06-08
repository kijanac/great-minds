import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createLocalContext } from "../db/client";
import { vaultMemberships, vaults } from "../db/schema";
import { ensureWorkspace } from "./bootstrap";
import { listSources, upsertSourceDocumentMetadata } from "./sources";
import { createVault, getVaultSettings, listVaults, switchVault, updateVault } from "./vaults";
import { APP_STATE_ID } from "./workspace";

async function createTestContext() {
  return createLocalContext({ dataDir: `memory://great-minds-test-${randomUUID()}` });
}

describe("local workspace spine", () => {
  it("applies bundled migrations", async () => {
    const ctx = await createTestContext();

    const applied = await ctx.client.query<{ name: string }>(
      `SELECT name FROM __great_minds_migrations ORDER BY name`,
    );

    expect(applied.rows.map((row) => row.name)).toEqual([
      "20260608140157_yellow_black_bird",
      "20260608153605_strange_rachel_grey",
      "20260608153749_overconfident_namorita",
      "20260608165852_spicy_krista_starr",
    ]);
  });

  it("creates the default workspace once", async () => {
    const ctx = await createTestContext();

    const first = await ensureWorkspace(ctx);
    const second = await ensureWorkspace(ctx);

    expect(second).toEqual(first);
    expect(first.appState.id).toBe(APP_STATE_ID);
    expect(first.user.email).toBe("local@great-minds.local");
    expect(first.vault.name).toBe("My Library");
    expect(first.vault.thematicHint).toBe("");
    expect(first.vault.kinds).toEqual(["person", "event", "organization", "concept"]);

    const memberships = await ctx.db
      .select()
      .from(vaultMemberships)
      .where(eq(vaultMemberships.vaultId, first.vault.id));

    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.userId).toBe(first.user.id);
    expect(memberships[0]?.role).toBe("owner");
  });

  it("creates, switches, updates, lists, and loads local vault settings", async () => {
    const ctx = await createTestContext();
    const initial = await ensureWorkspace(ctx);

    const created = await createVault(ctx, {
      name: "Political Economy",
      thematicHint: "Prefer debate-centric framings.",
      kinds: ["person", "event"],
    });

    expect(created.appState.currentVaultId).toBe(created.vault.id);
    expect(created.vault.name).toBe("Political Economy");
    expect(created.vault.thematicHint).toBe("Prefer debate-centric framings.");
    expect(created.vault.kinds).toEqual(["person", "event"]);

    const allVaults = await listVaults(ctx);
    expect(allVaults.map((vault) => vault.name)).toEqual(["My Library", "Political Economy"]);

    const switched = await switchVault(ctx, initial.vault.id);
    expect(switched.appState.currentVaultId).toBe(initial.vault.id);
    expect(switched.vault.name).toBe("My Library");

    const updated = await updateVault(ctx, {
      vaultId: initial.vault.id,
      thematicHint: "Prefer event-centric framings.",
    });

    expect(updated.vault.id).toBe(initial.vault.id);
    expect(updated.vault.thematicHint).toBe("Prefer event-centric framings.");
    expect(updated.vault.kinds).toEqual(["person", "event", "organization", "concept"]);

    const settings = await getVaultSettings(ctx, initial.vault.id);
    expect(settings.vault).toEqual(updated.vault);
    expect(settings.articleCount).toBe(0);
    expect(settings.members).toEqual([
      {
        userId: initial.user.id,
        email: "local@great-minds.local",
        role: "owner",
      },
    ]);

    const [persisted] = await ctx.db.select().from(vaults).where(eq(vaults.id, initial.vault.id));
    expect(persisted?.thematicHint).toBe("Prefer event-centric framings.");
  });

  it("upserts and lists source document metadata for the current vault", async () => {
    const ctx = await createTestContext();
    await ensureWorkspace(ctx);

    await upsertSourceDocumentMetadata(ctx, {
      filePath: "raw/document/capital.md",
      fileHash: "file-hash-1",
      bodyHash: "body-hash-1",
      clientHash: "client-hash-1",
      sourceType: "document",
      title: "Capital",
      author: "Karl Marx",
      publishedDate: "1867",
      genre: "book",
      precis: "A critique of political economy.",
      tags: ["economy", "capital"],
      derivedExtras: { tradition: "marxist" },
    });

    await upsertSourceDocumentMetadata(ctx, {
      filePath: "raw/session/exchange.md",
      fileHash: "file-hash-2",
      bodyHash: "body-hash-2",
      sourceType: "session",
      title: "Session note",
    });

    const firstPage = await listSources(ctx, { limit: 50, offset: 0 });
    expect(firstPage.pagination.total).toBe(2);
    expect(firstPage.facets.sourceTypes).toEqual([
      { value: "document", count: 1 },
      { value: "session", count: 1 },
    ]);
    expect(firstPage.items.map((item) => item.filePath).sort()).toEqual([
      "raw/document/capital.md",
      "raw/session/exchange.md",
    ]);

    const filtered = await listSources(ctx, { sourceType: "document", limit: 50, offset: 0 });
    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0]?.title).toBe("Capital");
    expect(filtered.items[0]?.derivedExtras).toEqual({ tradition: "marxist" });

    const searched = await listSources(ctx, { search: "marx", limit: 50, offset: 0 });
    expect(searched.items.map((item) => item.filePath)).toEqual(["raw/document/capital.md"]);
  });
});
