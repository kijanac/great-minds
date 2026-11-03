import { readFile } from "node:fs/promises";

import { Database, users, vaultMemberships, vaults } from "@great-minds/database";
import { Uuid } from "@great-minds/domain";
import { Effect, Schema, Stream } from "effect";
import { beforeEach, describe, expect, it } from "vitest";

import type { Article } from "../src/compile-articles.ts";
import { makeAskRunner } from "../src/compile-asks.ts";
import { findLinks, withLinks } from "../src/compile-links.ts";
import type { CompleteInput, ModelCompletion } from "../src/llm.ts";
import { runHistoryDatabase } from "./fixtures/reply-history-database.ts";

const uuid = Schema.decodeUnknownSync(Uuid);
const id = {
  user: uuid("90000000-0000-4000-8000-000000000001"),
  vault: uuid("90000000-0000-4000-8000-000000000002"),
  membership: uuid("90000000-0000-4000-8000-000000000003"),
  split: uuid("90000000-0000-4000-8000-000000000010"),
  liquidators: uuid("90000000-0000-4000-8000-000000000011"),
  peat: uuid("90000000-0000-4000-8000-000000000012"),
  run: uuid("90000000-0000-4000-8000-000000000020"),
  rerun: uuid("90000000-0000-4000-8000-000000000021"),
};
const article = (articleId: Uuid, title: string, description: string): Article => ({
  id: articleId,
  title,
  description,
  themeIds: [articleId],
  documentIds: [],
  ideaIds: [],
});
const catalogue = [
  article(id.split, "The 1903 split", "How the party divided at its second congress."),
  article(id.liquidators, "Liquidationism", "The tendency to dissolve the illegal party."),
  article(id.peat, "Peat extraction", "Fuel production from bogs in the 1920s."),
];
const body = [
  "# The 1903 split",
  "",
  "Years later the liquidators [^1] drew on the Menshevik case, while peat cutters worked on.",
  "",
  "---",
  "",
  '[^1]: [Source](raw/a.md) — "the liquidators"',
  "",
].join("\n");

const prompt = (name: string) =>
  readFile(new URL(`../src/default_prompts/${name}.md`, import.meta.url), "utf8").then((text) =>
    text.trim(),
  );
const settings = {
  pickModel: "deepseek/deepseek-v3.2",
  checkModel: "anthropic/claude-sonnet-5.5",
  mentionPrompt: await prompt("find_mentions"),
  pickPrompt: await prompt("pick_link_target"),
  checkPrompt: await prompt("check_link"),
  concurrency: 4,
};

const calls: CompleteInput[] = [];
const reply = (input: CompleteInput): ModelCompletion => {
  calls.push(input);
  const content = String(input.messages[0]?.content);
  const text = content.includes("Article:\n")
    ? JSON.stringify({
        mentions: [
          { phrase: "the liquidators", about: "liquidationist tendency" },
          { phrase: "peat cutters", about: "peat workers" },
          { phrase: "Bolsheviks", about: "not in the text" },
        ],
      })
    : content.includes("Library articles:")
      ? JSON.stringify({ choice: 1 })
      : JSON.stringify({ verdict: content.includes("Phrase: the liquidators") ? "yes" : "no" });
  return {
    text,
    finishReason: "stop",
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cost: 0.001 },
  };
};
const languageModel = {
  hasApiKey: true,
  streamChat: () => Stream.empty,
  complete: (input: CompleteInput) => Effect.sync(() => reply(input)),
};
const axis = (text: string) =>
  /liquidat/i.test(text) ? 0 : /peat/i.test(text) ? 1 : /split|congress/i.test(text) ? 2 : 3;
const embeddings = {
  embed: (texts: readonly string[]) =>
    Effect.succeed(
      texts.map((text) =>
        Array.from({ length: 4 }, (_unused, index) => (index === axis(text) ? 1 : 0)),
      ),
    ),
};
const logger = { info: () => Effect.void, warn: () => Effect.void, error: () => Effect.void };

const link = (runId: Uuid) =>
  runHistoryDatabase(
    Effect.gen(function* () {
      const db = yield* Database;
      const runner = yield* makeAskRunner(
        { db, languageModel, logger },
        { vaultId: id.vault, runId },
      );
      return yield* findLinks(
        { embeddings, runner },
        catalogue,
        [{ id: id.split, body }],
        settings,
      );
    }),
  );

beforeEach(async () => {
  calls.length = 0;
  await runHistoryDatabase(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.query((d) => d.delete(users));
      yield* db.query((d) => d.insert(users).values({ id: id.user, email: "links@example.com" }));
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.insert(vaults).values({ id: id.vault, name: "Links", ownerId: id.user });
          yield* tx
            .insert(vaultMemberships)
            .values({ id: id.membership, vaultId: id.vault, userId: id.user, role: "EDITOR" });
        }),
      );
    }),
  );
});

describe("links between articles", () => {
  it("keeps only mentions found in the text, picked from the search shortlist and confirmed by the check", async () => {
    const result = await link(id.run);
    expect(result.mentions).toBe(2);
    expect(result.linksOf.get(id.split)).toEqual([
      { phrase: "the liquidators", target: id.liquidators },
    ]);
    expect(result.failedQuestions).toBe(0);
    const pickPrompts = calls
      .map((call) => String(call.messages[0]?.content))
      .filter((content) => content.includes("Library articles:"));
    expect(pickPrompts).toHaveLength(2);
    expect(pickPrompts.find((content) => content.includes("Phrase: the liquidators"))).toContain(
      "1. Liquidationism —",
    );
    expect(pickPrompts.every((content) => !content.includes("The 1903 split —"))).toBe(true);
    const checkCall = calls.find((call) =>
      String(call.messages[0]?.content).includes("Other article:"),
    );
    expect(checkCall?.model).toBe("anthropic/claude-sonnet-5.5");
    expect(checkCall?.temperature).toBeUndefined();
  });

  it("asks nothing again when the articles are unchanged", async () => {
    const first = await link(id.run);
    calls.length = 0;
    const again = await link(id.rerun);
    expect(calls).toHaveLength(0);
    expect(again.linksOf).toEqual(first.linksOf);
  });

  it("inserts links into the prose only, at the first mention, for live targets", () => {
    const linked = withLinks(
      body,
      [
        { phrase: "the liquidators", target: id.liquidators },
        { phrase: "liquidators", target: id.peat },
        { phrase: "1903 split", target: id.split },
        { phrase: "peat cutters", target: id.peat },
      ],
      (target) => (target === id.peat ? undefined : `wiki/${target}.md`),
    );
    expect(linked).toContain(`Years later [the liquidators](wiki/${id.liquidators}.md) [^1]`);
    expect(linked).toContain("# The 1903 split\n");
    expect(linked).toContain("peat cutters worked on");
    expect(linked).toContain('— "the liquidators"');
  });
});
