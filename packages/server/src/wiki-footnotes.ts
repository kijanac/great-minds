import type { Uuid } from "@great-minds/domain";
import { Effect } from "effect";

import { footnoteDefinitions, footnoteNotes } from "./markdown.ts";
import { type ContentStorage, vaultOwner } from "./storage.ts";

export const withFootnoteNotes = <R extends { readonly path: string; readonly body: string }>(
  storage: ContentStorage["Service"],
  vaultId: Uuid,
  rows: readonly R[],
) =>
  Effect.gen(function* () {
    const paths = [...new Set(rows.map((row) => row.path))].filter((path) =>
      path.startsWith("wiki/"),
    );
    const definitions = new Map(
      yield* Effect.forEach(
        paths,
        (path) =>
          storage.readText(vaultOwner(vaultId), path).pipe(
            Effect.map(footnoteDefinitions),
            Effect.catchTag("StorageFileMissing", () => Effect.succeed(new Map<string, string>())),
            Effect.map((found) => [path, found] as const),
          ),
        { concurrency: 4 },
      ),
    );
    return rows.map((row) => {
      const notes = footnoteNotes(row.body, definitions.get(row.path) ?? new Map());
      return notes === "" ? row : { ...row, body: `${row.body}\n\n${notes}` };
    });
  });
