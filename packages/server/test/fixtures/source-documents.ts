import { sourceDocuments, sourceIncarnations, type TransactionClient } from "@great-minds/database";
import { Effect } from "effect";

import { fileContentHash } from "../../src/crypto.ts";
import { StorageFileMissing, type ContentStorage } from "../../src/storage.ts";
import { ObjectVersionConflict } from "../../src/storage/object-store.ts";
import { readSourceControl } from "../../src/source-identity.ts";

type LegacySource = Omit<typeof sourceDocuments.$inferInsert, "incarnationId">;

export const seedLegacySources = (
  tx: TransactionClient,
  input: LegacySource | readonly LegacySource[],
) =>
  Effect.forEach(
    "id" in input ? [input] : input,
    (source) =>
      Effect.gen(function* () {
        const incarnations = yield* tx
          .insert(sourceIncarnations)
          .values({
            sourceId: source.id,
            vaultId: source.vaultId,
            filePath: source.filePath,
            unversioned: true,
          })
          .returning({ id: sourceIncarnations.id });
        const incarnation = incarnations[0];
        if (incarnation === undefined) throw new Error("Source fixture returned no incarnation");
        return yield* tx
          .insert(sourceDocuments)
          .values({ ...source, incarnationId: incarnation.id });
      }),
    { concurrency: 1 },
  );

export const versionedSourceStorage = (
  files: Map<string, string>,
  write: (path: string, content: string) => void = (path, content) => {
    files.set(path, content);
  },
): Pick<
  ContentStorage["Service"],
  "readText" | "exists" | "readVersionedText" | "writeTextIfVersion"
> => {
  const readVersionedText: ContentStorage["Service"]["readVersionedText"] = (_owner, path) =>
    Effect.suspend(() => {
      const content = files.get(path);
      return content === undefined
        ? Effect.fail(new StorageFileMissing({ path }))
        : Effect.succeed({ content, version: fileContentHash(content) });
    });
  const readText: ContentStorage["Service"]["readText"] = (owner, path) =>
    Effect.gen(function* () {
      const { content } = yield* readVersionedText(owner, path);
      if (
        owner.kind === "vault" &&
        path.startsWith("raw/") &&
        readSourceControl(content) !== undefined
      ) {
        return yield* new StorageFileMissing({ path });
      }
      return content;
    });
  return {
    readText,
    exists: (owner, path) =>
      readText(owner, path).pipe(Effect.match({ onSuccess: () => true, onFailure: () => false })),
    readVersionedText,
    writeTextIfVersion: (_owner, path, expectedVersion, content) =>
      Effect.suspend(() => {
        const previous = files.get(path);
        const version = previous === undefined ? null : fileContentHash(previous);
        if (version !== expectedVersion)
          return Effect.fail(new ObjectVersionConflict({ key: path }));
        write(path, content);
        return Effect.void;
      }),
  };
};
