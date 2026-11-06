import { readFile } from "node:fs/promises";

import {
  Database,
  ideas,
  topicProposals,
  users,
  vaultMemberships,
  vaults,
} from "@great-minds/database";
import { Uuid } from "@great-minds/domain";
import { Effect, Schema, Stream } from "effect";
import { beforeEach, describe, expect, it } from "vitest";

import { buildArticles } from "../src/compile-articles.ts";
import { makeAskRunner } from "../src/compile-asks.ts";
import { contentHash } from "../src/crypto.ts";
import { loadBlocks, loadLibrary, type Theme } from "../src/compile-themes.ts";
import type { CompleteInput, ModelCompletion } from "../src/llm.ts";
import { seedLegacySources } from "./fixtures/source-documents.ts";
import { runHistoryDatabase } from "./fixtures/reply-history-database.ts";

const uuid = Schema.decodeUnknownSync(Uuid);
const id = {
  user: uuid("60000000-0000-4000-8000-000000000001"),
  vault: uuid("60000000-0000-4000-8000-000000000002"),
  membership: uuid("60000000-0000-4000-8000-000000000003"),
  run: uuid("60000000-0000-4000-8000-000000000004"),
  rerun: uuid("60000000-0000-4000-8000-000000000005"),
};
const hex = (prefix: string, n: number) => `${prefix}${n.toString(16).padStart(4, "0")}`;
const document = (n: number) => uuid(`60000000-0000-4000-8000-0000000${hex("1", n)}`);
const idea = (n: number) => uuid(`60000000-0000-4000-8000-0000000${hex("2", n)}`);
const proposal = (n: number) => uuid(`60000000-0000-4000-8000-0000000${hex("3", n)}`);
const unit = (axis: number) =>
  Array.from({ length: 1024 }, (_unused, index) => (index === axis ? 1 : 0));

type Spec = { readonly title: string; readonly axis: number; readonly docs: readonly number[] };
const specs = {
  liquidationism: { title: "Struggle against liquidationism", axis: 0, docs: [1, 2, 3, 4, 5] },
  liquidationismAgain: {
    title: "The Struggle Against Liquidationism",
    axis: 0,
    docs: [6, 7, 8, 9, 10],
  },
  peat: { title: "Peat extraction", axis: 1, docs: [11, 12, 13, 14, 15] },
  underground: { title: "The underground party press", axis: 0, docs: [16] },
  chess: { title: "Chess in exile", axis: 7, docs: [17] },
} satisfies Record<string, Spec>;
const themeOf = (spec: Spec): Theme => ({
  id: proposal(spec.docs[0] ?? 0),
  face: proposal(spec.docs[0] ?? 0),
  title: spec.title,
  description: `About ${spec.title}.`,
  members: spec.docs.map(proposal),
  documentIds: spec.docs.map(document),
  ideaIds: spec.docs.map(idea),
});
const themes = Object.values(specs).map(themeOf);

const facets = {
  press: { title: "Party press under censorship", axis: 3, docs: [21, 22, 23, 24, 25] },
  newspapers: { title: "Legal workers' newspapers", axis: 3, docs: [26, 27, 28, 29, 30] },
  printing: { title: "Underground printing shops", axis: 3, docs: [31, 32, 33, 34, 35] },
} satisfies Record<string, Spec>;
const facetThemes = Object.values(facets).map(themeOf);

const prompt = (name: string) =>
  readFile(new URL(`../src/default_prompts/${name}.md`, import.meta.url), "utf8").then((text) =>
    text.trim(),
  );
const settings = {
  model: "deepseek/deepseek-v3.2",
  mergePrompt: await prompt("judge_same_entry"),
  placePrompt: await prompt("place_in_article"),
  concurrency: 4,
  pivotsInFlight: 8,
  progress: () => Effect.void,
};

const calls: CompleteInput[] = [];
let sameWhen: (content: string) => boolean = () => false;
const reply = (input: CompleteInput): ModelCompletion => {
  calls.push(input);
  const content = String(input.messages[0]?.content);
  const text = content.includes("Article B:")
    ? JSON.stringify({ verdict: "yes", reason: "Within its subject." })
    : JSON.stringify(
        sameWhen(content)
          ? { relation: "same", reason: "One subject." }
          : { relation: "related", reason: "Different framing." },
      );
  return {
    text,
    finishReason: "stop",
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cost: 0.001 },
  };
};
const languageModel = {
  streamChat: () => Stream.empty,
  complete: (input: CompleteInput) => Effect.sync(() => reply(input)),
};
const logger = { info: () => Effect.void, warn: () => Effect.void, error: () => Effect.void };

const build = (runId: Uuid, input: readonly Theme[] = themes) =>
  runHistoryDatabase(
    Effect.gen(function* () {
      const db = yield* Database;
      const runner = yield* makeAskRunner(
        { db, languageModel, logger },
        { vaultId: id.vault, runId },
      );
      const blocks = yield* loadBlocks(db, id.vault, yield* loadLibrary(db, id.vault));
      return yield* buildArticles({ db, runner }, blocks, input, settings);
    }),
  );

beforeEach(async () => {
  calls.length = 0;
  sameWhen = () => false;
  await runHistoryDatabase(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.query((d) => d.delete(users));
      yield* db.query((d) =>
        d.insert(users).values({ id: id.user, email: "articles@example.com" }),
      );
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.insert(vaults).values({ id: id.vault, name: "Articles", ownerId: id.user });
          yield* tx
            .insert(vaultMemberships)
            .values({ id: id.membership, vaultId: id.vault, userId: id.user, role: "EDITOR" });
          const all = [...Object.values(specs), ...Object.values(facets)].flatMap((spec) =>
            spec.docs.map((n) => ({ n, spec })),
          );
          yield* seedLegacySources(
            tx,
            all.map(({ n }) => ({
              id: document(n),
              vaultId: id.vault,
              filePath: `raw/doc-${n}.md`,
              fileHash: `file-${n}`,
              bodyHash: `body-${n}`,
              sourceType: "document",
              title: `Document ${n}`,
            })),
          );
          yield* tx.insert(ideas).values(
            all.map(({ n, spec }) => ({
              ideaId: idea(n),
              vaultId: id.vault,
              documentId: document(n),
              kind: "concept",
              label: `${spec.title} ${n}`,
              description: `From document ${n}`,
            })),
          );
          yield* tx.insert(topicProposals).values(
            all.map(({ n, spec }) => ({
              id: proposal(n),
              vaultId: id.vault,
              documentId: document(n),
              askKey: `answer-${n}`,
              position: 0,
              title: spec.title,
              description: `About ${spec.title}.`,
              inclusionTest: "It is about this.",
              ideaIds: [idea(n)],
              embedding: unit(spec.axis),
              paired: true,
            })),
          );
        }),
      );
    }),
  );
});

describe("articles from themes", () => {
  it("joins same-named big themes, keeps different ones apart, and places a small theme only where it is asked and accepted", async () => {
    const result = await build(id.run);
    expect(result.articles).toHaveLength(2);
    expect(result.articles.map((article) => article.title)).toContain("Peat extraction");
    const liquidationism = result.articles.find((article) =>
      article.themeIds.includes(themeOf(specs.liquidationism).id),
    );
    expect([specs.liquidationism.title, specs.liquidationismAgain.title]).toContain(
      liquidationism?.title,
    );
    expect(new Set(liquidationism?.themeIds)).toEqual(
      new Set(
        [specs.liquidationism, specs.liquidationismAgain, specs.underground].map(
          (spec) => themeOf(spec).id,
        ),
      ),
    );
    expect(liquidationism?.documentIds).toHaveLength(11);
    expect(result.placedThemes).toBe(1);
    expect(result.unplacedThemes).toBe(1);
    expect(result.failedQuestions).toBe(0);
    expect(calls).toHaveLength(4);
  });

  it("asks nothing again and builds the same articles when nothing changed", async () => {
    const first = await build(id.run);
    calls.length = 0;
    const again = await build(id.rerun);
    expect(calls).toHaveLength(0);
    expect(again.articles).toEqual(first.articles);
  });

  describe("grouping", () => {
    const inOrder = Object.values(facets).toSorted((left, right) =>
      contentHash(`answer-${left.docs[0]}`, "0") < contentHash(`answer-${right.docs[0]}`, "0")
        ? -1
        : 1,
    );
    const [first, second, third] = inOrder.map((spec) => spec.title);
    const names = (content: string) =>
      [first, second, third].filter((title) => title !== undefined && content.includes(title));
    const themeLevel = (content: string) => {
      const shown = names(content);
      return (
        shown.length === 2 &&
        ((shown.includes(first ?? "") && shown.includes(second ?? "")) ||
          (shown.includes(second ?? "") && shown.includes(third ?? "")))
      );
    };
    const facetArticles = (articles: readonly { readonly themeIds: readonly Uuid[] }[]) =>
      articles
        .map((article) =>
          article.themeIds
            .flatMap((themeId) => facetThemes.find((theme) => theme.id === themeId)?.title ?? [])
            .toSorted(),
        )
        .filter((titles) => titles.length > 0)
        .toSorted((left, right) => (left.join() < right.join() ? -1 : 1));

    it("does not chain: A same as B and B same as C does not put C with A", async () => {
      sameWhen = themeLevel;
      const result = await build(id.run, facetThemes);
      expect(facetArticles(result.articles)).toEqual(
        [[first, second].toSorted(), [third]].toSorted((left, right) =>
          left.join() < right.join() ? -1 : 1,
        ),
      );
      expect(result.failedQuestions).toBe(0);
    });

    it("builds the same articles whatever order the themes arrive in, and asks nothing again", async () => {
      sameWhen = themeLevel;
      const forward = await build(id.run, facetThemes);
      calls.length = 0;
      const backward = await build(id.rerun, facetThemes.toReversed());
      expect(calls).toHaveLength(0);
      expect(backward.articles).toEqual(forward.articles);
    });
  });
});
