import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";

import { fontAssets, publicationFonts } from "../src/publication/assets.ts";

const install = Effect.gen(function* () {
  yield* Effect.promise(() => rm(publicationFonts, { recursive: true, force: true }));
  yield* Effect.promise(() => mkdir(publicationFonts, { recursive: true }));
  for (const asset of fontAssets) {
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
    if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
      return yield* Effect.die(new Error(`Font checksum mismatch: ${asset.name}`));
    yield* Effect.promise(() => writeFile(join(publicationFonts, asset.name), bytes));
  }
  console.log(`Installed verified publication fonts and licenses in ${publicationFonts}`);
});

await Effect.runPromise(install);
