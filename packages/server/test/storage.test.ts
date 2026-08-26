import { access, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { pruneLocalStaging } from "../src/storage/local-object-store.ts";

const roots: string[] = [];

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local staging maintenance", () => {
  it("removes expired objects without deleting current uploads", async () => {
    const root = await mkdtemp(join(tmpdir(), "gm-storage-"));
    roots.push(root);
    const staging = join(root, "staging", "vault", "batch");
    const expired = join(staging, "expired");
    const current = join(staging, "current");
    await mkdir(staging, { recursive: true });
    await writeFile(expired, "old");
    await writeFile(current, "new");
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await utimes(expired, old, old);

    await Effect.runPromise(pruneLocalStaging(root, Date.now() - 24 * 60 * 60 * 1000));

    expect(await exists(expired)).toBe(false);
    expect(await exists(current)).toBe(true);
  });
});
