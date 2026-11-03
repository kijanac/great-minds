import {
  compileCacheEntries,
  Database,
  llmCostEvents,
  users,
  vaultMemberships,
  vaults,
} from "@great-minds/database";
import { Uuid } from "@great-minds/domain";
import { eq } from "drizzle-orm";
import { Effect, Schema, Stream } from "effect";
import { beforeEach, describe, expect, it } from "vitest";

import { makeAskRunner, type AskRequest } from "../src/compile-asks.ts";
import type { CompleteInput, ModelCompletion } from "../src/llm.ts";
import { runHistoryDatabase } from "./fixtures/reply-history-database.ts";

const uuid = Schema.decodeUnknownSync(Uuid);
const id = {
  user: uuid("30000000-0000-4000-8000-000000000001"),
  vault: uuid("30000000-0000-4000-8000-000000000002"),
  membership: uuid("30000000-0000-4000-8000-000000000003"),
  run: uuid("30000000-0000-4000-8000-000000000004"),
  rerun: uuid("30000000-0000-4000-8000-000000000005"),
};

const Verdict = Schema.Struct({ verdict: Schema.Literals(["yes", "no"] as const) });
const question = (text: string): AskRequest<typeof Verdict.Type, typeof Verdict.Encoded> => ({
  kind: "verdict",
  model: "deepseek/deepseek-v3.2",
  messages: [{ role: "user", content: text }],
  temperature: 0,
  responseFormat: { type: "json_object" },
  answer: Verdict,
});

const calls: CompleteInput[] = [];
let reply = (_input: CompleteInput): ModelCompletion => ({
  text: '{"verdict":"yes"}',
  finishReason: "stop",
  usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, cost: 0.01 },
});
const languageModel = {
  hasApiKey: true,
  streamChat: () => Stream.empty,
  complete: (input: CompleteInput) =>
    Effect.sync(() => {
      calls.push(input);
      return reply(input);
    }),
};
const logger = { info: () => Effect.void, warn: () => Effect.void, error: () => Effect.void };

const withRunner = <A, E>(
  runId: Uuid,
  use: (runner: Effect.Success<ReturnType<typeof makeAskRunner>>) => Effect.Effect<A, E>,
) =>
  runHistoryDatabase(
    Effect.gen(function* () {
      const db = yield* Database;
      const runner = yield* makeAskRunner(
        { db, languageModel, logger },
        { vaultId: id.vault, runId },
      );
      return yield* use(runner);
    }),
  );

const rows = () =>
  runHistoryDatabase(
    Effect.gen(function* () {
      const db = yield* Database;
      return {
        saved: yield* db.query((d) =>
          d.select().from(compileCacheEntries).where(eq(compileCacheEntries.vaultId, id.vault)),
        ),
        costs: yield* db.query((d) =>
          d.select().from(llmCostEvents).where(eq(llmCostEvents.vaultId, id.vault)),
        ),
      };
    }),
  );

beforeEach(async () => {
  calls.length = 0;
  reply = () => ({
    text: '{"verdict":"yes"}',
    finishReason: "stop",
    usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, cost: 0.01 },
  });
  await runHistoryDatabase(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.query((d) => d.delete(users));
      yield* db.query((d) => d.insert(users).values({ id: id.user, email: "asks@example.com" }));
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.insert(vaults).values({ id: id.vault, name: "Asks", ownerId: id.user });
          yield* tx
            .insert(vaultMemberships)
            .values({ id: id.membership, vaultId: id.vault, userId: id.user, role: "EDITOR" });
        }),
      );
    }),
  );
});

describe("saved model questions", () => {
  it("asks a question once and reuses its saved answer, in later runs too", async () => {
    const first = await withRunner(id.run, (runner) => runner.ask(question("Is A part of B?")));
    const again = await withRunner(id.rerun, (runner) => runner.ask(question("Is A part of B?")));
    expect(first).toEqual({ verdict: "yes" });
    expect(again).toEqual({ verdict: "yes" });
    expect(calls).toHaveLength(1);
    const state = await rows();
    expect(state.saved).toHaveLength(1);
    expect(state.costs.map((row) => row.runId)).toEqual([id.run]);
    expect(state.costs.map((row) => row.userId)).toEqual([id.user]);
  });

  it("records the cost of a cut-off or malformed reply but saves no answer, so the next run asks again", async () => {
    reply = () => ({
      text: '{"verd',
      finishReason: "length",
      usage: { promptTokens: 10, completionTokens: 9, totalTokens: 19, cost: 0.01 },
    });
    const cut = await withRunner(id.run, (runner) => Effect.exit(runner.ask(question("long"))));
    reply = () => ({
      text: '{"verdict":"maybe"}',
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 3, totalTokens: 13, cost: 0.01 },
    });
    const malformed = await withRunner(id.run, (runner) =>
      Effect.exit(runner.ask(question("long"))),
    );
    expect(JSON.stringify(cut)).toContain("truncated");
    expect(JSON.stringify(malformed)).toContain("malformed");
    const state = await rows();
    expect(state.saved).toHaveLength(0);
    expect(state.costs).toHaveLength(2);
    expect(calls).toHaveLength(2);
  });
});
