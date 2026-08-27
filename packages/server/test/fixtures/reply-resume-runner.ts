import { appendFile } from "node:fs/promises";

import { Database, replies } from "@great-minds/database";
import type { Uuid } from "@great-minds/domain";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";

import { makeAppLayer } from "../../src/app-layer.ts";
import { LanguageModel, type StreamChatInput } from "../../src/llm.ts";
import { RepliesService } from "../../src/replies.ts";

const mode = process.argv[2] as "pause" | "resume" | undefined;
const replyId = process.argv[3] as Uuid | undefined;
const markerPath = process.argv[4];
if (mode === undefined || replyId === undefined || markerPath === undefined) {
  throw new Error("mode, reply id, and marker path are required");
}

const LanguageLive = Layer.succeed(LanguageModel, {
  hasApiKey: true,
  streamChat: (_input: StreamChatInput) => {
    async function* stream() {
      await appendFile(markerPath, `${mode}\n`, "utf8");
      console.log(`REPLY provider called mode=${mode}`);
      if (mode === "resume") {
        throw new Error("ambiguous provider call was repeated");
      }
      yield { type: "token" as const, text: "partial" };
      await new Promise<never>(() => undefined);
    }
    return stream();
  },
  complete: async () => {
    throw new Error("complete unexpectedly called");
  },
});

const MainLive = makeAppLayer({ languageModel: LanguageLive });

const pollReply = (predicate: (row: typeof replies.$inferSelect) => boolean) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const rows = yield* db.query((d) => d
        .select()
        .from(replies)
        .where(eq(replies.id, replyId))
        .limit(1));
      const row = rows[0];
      if (row !== undefined && predicate(row)) return row;
      yield* Effect.sleep("25 millis");
    }
    throw new Error(`reply ${replyId} did not reach the expected state`);
  });

const program = Effect.gen(function* () {
  const service = yield* RepliesService;
  if (mode === "pause") {
    yield* service.reconcileOnce();
    const row = yield* pollReply(
      (candidate) =>
        candidate.dispatchedAt !== null &&
        candidate.activeGenerationKind === "model" &&
        candidate.activeGenerationStep === 0,
    );
    console.log(`REPLY active cursor=${row.generationCursor}`);
    return yield* Effect.never;
  }

  const row = yield* pollReply((candidate) => candidate.status !== "running");
  console.log(`REPLY terminal status=${row.status} cursor=${row.generationCursor}`);
});

await Effect.runPromise(program.pipe(Effect.provide(MainLive)));
