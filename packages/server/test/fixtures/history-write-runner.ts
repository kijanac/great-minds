import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

import { Effect } from "effect";

import { makeHistoryStore } from "../../src/conversation-history/store.ts";
import { attempt, header, sessionId, settlement, vaultId } from "./conversation-history.ts";

const [directory, phase, mode] = process.argv.slice(2);
if (
  directory === undefined ||
  (phase !== "before-rename" && phase !== "after-rename") ||
  (mode !== "first" && mode !== "replacement")
) {
  throw new Error("Expected directory, replacement phase, and write mode");
}

process.on("disconnect", () => process.exit(2));
const pause = () =>
  new Promise<never>(() => {
    if (process.send === undefined) throw new Error("IPC channel required");
    process.send(phase);
  });

const rename = fs.rename;
fs.rename = async (from, to) => {
  if (phase === "before-rename") await pause();
  await rename(from, to);
  if (phase === "after-rename") await pause();
};
syncBuiltinESMExports();

const { openLocalConditionalObjectStore } =
  await import("../../src/storage/local-conditional-object-store.ts");
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const objects = yield* openLocalConditionalObjectStore(directory);
      const store = makeHistoryStore(objects);
      yield* store.commit(
        { vault_id: vaultId, session_id: sessionId },
        mode === "first" ? [header(), attempt()] : [settlement()],
      );
      throw new Error("Write completed without reaching the crash point");
    }),
  ),
);
