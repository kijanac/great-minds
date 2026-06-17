import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Effect } from "effect";
import { afterEach, describe, expect, test, vi } from "vitest";
import { VaultInternalSchema } from "@great-minds/domain/vault";
import { createVaultStorage } from "./storage.js";

const vault = VaultInternalSchema.parse({
  id: "22222222-2222-4222-8222-222222222222",
  ownerId: "11111111-1111-4111-8111-111111111111",
  name: "Test Vault",
  storageBucketName: null,
  thematicHint: "",
  kinds: ["person", "event", "organization", "concept"],
  createdAt: new Date("2026-01-01T00:00:00Z"),
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createVaultStorage", () => {
  test("writes local source text inside the vault root", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "great-minds-storage-"));
    const storage = createVaultStorage({ kind: "local", dataDir });

    const result = await Effect.runPromise(
      storage.writeText(vault, "raw/docs/source.md", "Hello source"),
    );

    expect(result).toEqual({ etag: null });
    await expect(
      readFile(path.join(dataDir, "vaults", vault.id, "raw/docs/source.md"), "utf-8"),
    ).resolves.toBe("Hello source");
  });

  test("clears the local vault storage root", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "great-minds-storage-"));
    const filePath = path.join(dataDir, "vaults", vault.id, "raw", "source.md");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "source", { encoding: "utf-8", flush: true });

    const storage = createVaultStorage({ kind: "local", dataDir });
    await Effect.runPromise(storage.clearVault(vault));

    await expect(stat(path.join(dataDir, "vaults", vault.id))).rejects.toThrow();
  });

  test("deletes local source text inside the vault root", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "great-minds-storage-"));
    const filePath = path.join(dataDir, "vaults", vault.id, "raw", "docs", "source.md");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "source", { encoding: "utf-8", flush: true });

    const storage = createVaultStorage({ kind: "local", dataDir });
    await Effect.runPromise(storage.deleteText(vault, "raw/docs/source.md"));

    await expect(stat(filePath)).rejects.toThrow();
  });

  test("prepares R2 buckets before returning the bucket name", async () => {
    const commands: unknown[] = [];
    vi.spyOn(S3Client.prototype, "send").mockImplementation((command: unknown) => {
      commands.push(command);
      if (command instanceof HeadBucketCommand) {
        return Promise.reject(Object.assign(new Error("missing"), { name: "NoSuchBucket" }));
      }
      return Promise.resolve({});
    });

    const storage = createVaultStorage({
      kind: "r2",
      accountId: "account",
      accessKeyId: "access-key",
      secretAccessKey: "secret-key",
      bucketPrefix: "gm",
    });

    const bucketName = await Effect.runPromise(storage.prepareBucketForOwner(vault.ownerId));

    expect(bucketName).toBe("gm-11111111111141118111111111111111");
    expect(commands).toEqual([
      expect.any(HeadBucketCommand),
      expect.any(CreateBucketCommand),
      expect.any(PutBucketLifecycleConfigurationCommand),
    ]);
  });

  test("writes R2 source text under the vault prefix", async () => {
    const send = vi
      .spyOn(S3Client.prototype, "send")
      .mockImplementation(() => Promise.resolve({ ETag: "etag-source" }));
    const storage = createVaultStorage({
      kind: "r2",
      accountId: "account",
      accessKeyId: "access-key",
      secretAccessKey: "secret-key",
      bucketPrefix: "gm",
    });

    const result = await Effect.runPromise(
      storage.writeText({ ...vault, storageBucketName: "gm-owner" }, "raw/docs/source.md", "Hello"),
    );

    expect(result).toEqual({ etag: "etag-source" });
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(PutObjectCommand);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      input: {
        Bucket: "gm-owner",
        Key: `vaults/${vault.id}/raw/docs/source.md`,
        Body: "Hello",
        ContentType: "text/markdown; charset=utf-8",
      },
    });
  });

  test("deletes R2 source text under the vault prefix", async () => {
    const send = vi.spyOn(S3Client.prototype, "send").mockImplementation(() => Promise.resolve({}));
    const storage = createVaultStorage({
      kind: "r2",
      accountId: "account",
      accessKeyId: "access-key",
      secretAccessKey: "secret-key",
      bucketPrefix: "gm",
    });

    await Effect.runPromise(
      storage.deleteText({ ...vault, storageBucketName: "gm-owner" }, "raw/docs/source.md"),
    );

    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(DeleteObjectCommand);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      input: {
        Bucket: "gm-owner",
        Key: `vaults/${vault.id}/raw/docs/source.md`,
      },
    });
  });

  test("rejects invalid R2 bucket names before network calls", async () => {
    const send = vi.spyOn(S3Client.prototype, "send");
    const storage = createVaultStorage({
      kind: "r2",
      accountId: "account",
      accessKeyId: "access-key",
      secretAccessKey: "secret-key",
      bucketPrefix: "this-prefix-is-way-too-long-for-r2-bucket-names",
    });

    const result = await Effect.runPromiseExit(storage.prepareBucketForOwner(vault.ownerId));

    expect(result._tag).toBe("Failure");
    expect(send).not.toHaveBeenCalled();
  });
});
