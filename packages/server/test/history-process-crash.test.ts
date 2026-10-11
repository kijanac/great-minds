import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Result } from "effect";
import { describe, expect, it } from "vitest";

import { parseHistory } from "../src/conversation-history/history.ts";
import { makeHistoryStore } from "../src/conversation-history/store.ts";
import { openLocalConditionalObjectStore } from "../src/storage/local-conditional-object-store.ts";
import {
  attempt,
  header,
  sessionId,
  settlement,
  vaultId,
} from "./fixtures/conversation-history.ts";
import { failure } from "./fixtures/history-storage.ts";

const address = { vault_id: vaultId, session_id: sessionId };
const key = `vaults/${vaultId}/sessions/${sessionId}.jsonl`;

const startPausedWriter = (directory: string, phase: string, mode: string) => {
  const child = fork(
    new URL("./fixtures/history-write-runner.ts", import.meta.url),
    [directory, phase, mode],
    {
      execArgv: ["--experimental-strip-types"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  let stderr = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const ready = new Promise<void>((resolve, reject) => {
    const exited = () => reject(new Error(`Writer exited before the crash point: ${stderr}`));
    child.once("exit", exited);
    child.once("error", reject);
    child.once("message", (message: unknown) => {
      if (message !== phase) {
        reject(new Error(`Unexpected writer message: ${String(message)}`));
        return;
      }
      child.removeListener("exit", exited);
      resolve();
    });
  });
  const kill = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  };
  return { ready, kill };
};

describe("local history process-crash boundaries", () => {
  for (const mode of ["first", "replacement"] as const) {
    it.each(["before-rename", "after-rename"] as const)(
      `${mode} write killed %s leaves a complete destination and releases ownership without cleanup`,
      async (phase) => {
        const directory = await mkdtemp(join(tmpdir(), "gm-history-crash-"));
        try {
          if (mode === "replacement") {
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function* () {
                  const objects = yield* openLocalConditionalObjectStore(directory);
                  yield* makeHistoryStore(objects).commit(address, [header(), attempt()]);
                }),
              ),
            );
          }
          const writer = startPausedWriter(directory, phase, mode);
          try {
            await writer.ready;
            const beforeKill = await Effect.runPromise(
              Effect.scoped(Effect.exit(openLocalConditionalObjectStore(directory))),
            );
            expect(failure(beforeKill)).toMatchObject({ _tag: "LocalHistoryWriterBusy" });
            await writer.kill();
            await Effect.runPromise(Effect.scoped(openLocalConditionalObjectStore(directory)));
            if (mode === "first" && phase === "before-rename") {
              await expect(readFile(join(directory, key))).rejects.toMatchObject({
                code: "ENOENT",
              });
            } else {
              const parsed = parseHistory(sessionId, await readFile(join(directory, key)));
              expect(parsed._tag).toBe("Success");
              if (Result.isFailure(parsed)) throw parsed.failure;
              expect(parsed.success.revision.last_seq).toBe(
                mode === "replacement" && phase === "after-rename" ? 3 : 2,
              );
            }
            const recovered = await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function* () {
                  const objects = yield* openLocalConditionalObjectStore(directory);
                  return yield* makeHistoryStore(objects).commit(
                    address,
                    mode === "first" ? [header(), attempt()] : [settlement()],
                  );
                }),
              ),
            );
            expect(recovered.written).toBe(phase === "before-rename");
            expect(recovered.history.revision.last_seq).toBe(mode === "first" ? 2 : 3);
          } finally {
            await writer.kill();
          }
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
    );
  }
});
