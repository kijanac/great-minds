import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";

import { fontAssets, publicationFonts } from "../src/publication/assets.ts";

const verified = (bytes: Uint8Array, sha256: string) =>
  createHash("sha256").update(bytes).digest("hex") === sha256;

const install = Effect.gen(function* () {
  yield* Effect.promise(() => mkdir(publicationFonts, { recursive: true }));
  const wanted = new Set(fontAssets.map((asset) => asset.name));
  for (const name of yield* Effect.promise(() => readdir(publicationFonts)))
    if (!wanted.has(name))
      yield* Effect.promise(() => rm(join(publicationFonts, name), { recursive: true }));
  for (const asset of fontAssets) {
    const target = join(publicationFonts, asset.name);
    const existing = yield* Effect.promise(() => readFile(target).catch(() => undefined));
    if (existing !== undefined && verified(existing, asset.sha256)) continue;
    const bytes = yield* asset.url.protocol === "file:"
      ? Effect.promise(() => readFile(asset.url))
      : Effect.gen(function* () {
          const response = yield* Effect.promise((signal) => fetch(asset.url, { signal }));
          if (!response.ok)
            return yield* Effect.die(
              new Error(`Font download failed: ${asset.name} (${response.status})`),
            );
          return new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()));
        });
    if (!verified(bytes, asset.sha256))
      return yield* Effect.die(new Error(`Font checksum mismatch: ${asset.name}`));
    yield* Effect.promise(() => writeFile(target, bytes));
  }
  console.log(`Installed verified publication fonts and licenses in ${publicationFonts}`);
});

await Effect.runPromise(install);
