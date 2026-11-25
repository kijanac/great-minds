import { FileFingerprint, Uuid } from "@great-minds/domain";
import { afterEach, expect, it, vi } from "vitest";

import { fileIngestDrafts, forgetUpload, rememberUpload } from "./file-ingest-drafts.svelte";

vi.mock("#lib/auth.svelte.ts", () => ({ auth: { userId: "owner" } }));

afterEach(() => sessionStorage.clear());

it("reuses an unconfirmed batch only for the same account, vault and ordered manifest", () => {
  const vault = Uuid.make("00000000-0000-4000-8000-000000000001");
  const otherVault = Uuid.make("00000000-0000-4000-8000-000000000002");
  const first = {
    name: "a.md",
    size: 12,
    hash: FileFingerprint.make("a".repeat(64)),
    mimetype: "text/markdown",
  };
  const second = { ...first, name: "b.md", hash: FileFingerprint.make("b".repeat(64)) };
  const draft = rememberUpload("owner", vault, [first, second]);

  expect(rememberUpload("owner", vault, [{ ...first }, { ...second }])).toEqual(draft);
  const otherAccount = rememberUpload("another owner", vault, [first, second]);
  for (const other of [
    otherAccount,
    rememberUpload("owner", otherVault, [first, second]),
    rememberUpload("owner", vault, [second, first]),
    rememberUpload("owner", vault, [{ ...first, name: "new.md" }, second]),
    rememberUpload("owner", vault, [{ ...first, size: 13 }, second]),
    rememberUpload("owner", vault, [{ ...first, mimetype: "text/plain" }, second]),
  ]) {
    expect(other.batchId).not.toBe(draft.batchId);
  }
  expect(fileIngestDrafts()).not.toContainEqual(otherAccount);
  forgetUpload("owner", draft.batchId);
  expect(fileIngestDrafts()).not.toContainEqual(draft);
  expect(rememberUpload("owner", vault, [first, second]).batchId).not.toBe(draft.batchId);
});
