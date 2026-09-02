import { readFile } from "node:fs/promises";

import type { Uuid } from "@great-minds/domain";
import { Effect } from "effect";

import { type ContentStorage, vaultOwner } from "./storage.ts";

const promptUrl = (name: string) => new URL(`./default_prompts/${name}.md`, import.meta.url);

export const loadPrompt = (storage: ContentStorage["Service"], vaultId: Uuid, name: string) =>
  storage.readText(vaultOwner(vaultId), `prompts/${name}.md`).pipe(
    Effect.catchTag("StorageFileMissing", () =>
      Effect.tryPromise(() => readFile(promptUrl(name), "utf8")).pipe(Effect.orDie),
    ),
    Effect.map((content) => content.trim()),
  );
