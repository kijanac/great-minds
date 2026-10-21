import { appendFile } from "node:fs/promises";

import { Database, replies } from "@great-minds/database";
import { Uuid } from "@great-minds/domain";
import { eq } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";

import { makeAppLayer } from "../../src/app-layer.ts";
import type { HistoryStoreShape } from "../../src/conversation-history/store.ts";
import { LanguageModel, type StreamChatInput } from "../../src/llm.ts";
import { ParallelSearchService } from "../../src/parallel.ts";
import { RepliesService, ReplyWorkflow } from "../../src/replies.ts";
import { storageBackendError } from "../../src/storage/object-store.ts";
import { finishPart, tokenPart, toolCallPart } from "../query-stubs.ts";

const mode = Schema.decodeUnknownSync(
  Schema.Literals([
    "pause",
    "resume",
    "save-result",
    "fail-result",
    "resume-result",
    "save-admission",
    "resume-admission",
  ]),
)(process.argv[2]);
const replyId = Schema.decodeUnknownSync(Uuid)(process.argv[3]);
const markerPath = Schema.decodeUnknownSync(Schema.NonEmptyString)(process.argv[4]);
Schema.decodeUnknownSync(Schema.NonEmptyString)(process.env.DATA_DIR);

let modelCalls = 0;
const LanguageLive = Layer.succeed(LanguageModel, {
  hasApiKey: true,
  streamChat: (_input: StreamChatInput) => {
    async function* stream() {
      modelCalls += 1;
      await appendFile(markerPath, `model:${mode}\n`, "utf8");
      console.log(`REPLY provider called mode=${mode}`);
      if (mode === "resume" || mode === "resume-result" || mode === "save-admission")
        throw new Error("Provider call must not be repeated or precede admission");
      if (mode === "pause") {
        yield tokenPart("partial");
        await new Promise<never>(() => undefined);
      } else if ((mode === "save-result" || mode === "fail-result") && modelCalls === 1) {
        yield toolCallPart(0, "durable-search", "web_search", { query: "durability lookup" });
        yield finishPart("tool_calls", undefined, { cost: 0 });
      } else {
        yield tokenPart("Saved once.");
        yield finishPart("stop", undefined, { cost: 0 });
      }
    }
    return stream();
  },
  complete: () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => appendFile(markerPath, `complete:${mode}\n`, "utf8"));
      return yield* Effect.fail(new Error("complete unexpectedly called"));
    }),
});

const SearchLive = Layer.succeed(ParallelSearchService, {
  hasApiKey: true,
  search: () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => appendFile(markerPath, `tool:${mode}\n`, "utf8"));
      if (mode !== "save-result" && mode !== "fail-result")
        return yield* Effect.die(new Error("Tool must not be repeated"));
      return [];
    }),
});

const decorateHistory = (histories: HistoryStoreShape): HistoryStoreShape => ({
  ...histories,
  commit: (address, writes, receipt) =>
    Effect.gen(function* () {
      if (mode === "save-result" && writes.some((write) => write.type === "settlement")) {
        console.log("REPLY settlement waiting");
        return yield* Effect.never;
      }
      if (mode === "fail-result" && writes.some((write) => write.type === "settlement")) {
        return yield* Effect.fail(
          storageBackendError(
            "write",
            address.session_id,
            new Error("Injected publication outage"),
          ),
        );
      }
      const committed = yield* histories.commit(address, writes, receipt);
      if (mode === "save-admission") {
        console.log("REPLY admission saved");
        return yield* Effect.never;
      }
      return committed;
    }),
});

const MainLive = makeAppLayer({
  languageModel: LanguageLive,
  parallelSearch: SearchLive,
  decorateHistory,
});
const pollReply = (predicate: (row: typeof replies.$inferSelect) => boolean) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const rows = yield* db.query((d) =>
        d.select().from(replies).where(eq(replies.id, replyId)).limit(1),
      );
      const row = rows[0];
      if (row !== undefined && predicate(row)) return row;
      yield* Effect.sleep("25 millis");
    }
    throw new Error(`reply ${replyId} did not reach the expected state`);
  });

const program = Effect.gen(function* () {
  const service = yield* RepliesService;
  if (mode === "save-admission") yield* service.prepareStep(replyId);
  if (mode === "resume-result") {
    const row = yield* pollReply(() => true);
    yield* service.stop(row.userId, row.vaultId, replyId);
    yield* service.prepareStep(replyId);
    yield* service.modelStep(replyId, row.generationCursor);
    yield* service.toolStep(replyId, row.generationCursor);
  }
  yield* service.reconcileOnce();
  if (mode === "pause") {
    const row = yield* pollReply(
      (candidate) =>
        candidate.dispatchedAt !== null &&
        candidate.activeGenerationKind === "model" &&
        candidate.activeGenerationStep === 0 &&
        candidate.answer === "partial",
    );
    console.log(`REPLY active cursor=${row.generationCursor}`);
    return yield* Effect.never;
  }
  if (mode === "save-result") return yield* Effect.never;
  if (mode === "fail-result") {
    yield* ReplyWorkflow.execute({ replyId });
    console.log("REPLY workflow complete while settling");
    return yield* Effect.never;
  }
  const row = yield* pollReply(
    (candidate) =>
      candidate.status === "completed" ||
      candidate.status === "stopped" ||
      candidate.status === "failed",
  );
  yield* ReplyWorkflow.execute({ replyId });
  console.log(`REPLY terminal status=${row.status} cursor=${row.generationCursor}`);
});

await Effect.runPromise(program.pipe(Effect.provide(MainLive)));
