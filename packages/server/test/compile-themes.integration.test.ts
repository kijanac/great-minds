import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  anchors,
  Database,
  ideas,
  topicCandidates,
  topicProposals,
  users,
  vaultMemberships,
  vaults,
} from "@great-minds/database";
import { Uuid } from "@great-minds/domain";
import { Effect, Schema, Stream } from "effect";
import { beforeEach, describe, expect, it } from "vitest";

import { makeAskRunner } from "../src/compile-asks.ts";
import {
  groupThemes,
  loadBlocks,
  loadLibrary,
  pairCandidates,
  pivotGroups,
  proposeTopics,
} from "../src/compile-themes.ts";
import type { CompleteInput, ModelCompletion } from "../src/llm.ts";
import { seedLegacySources } from "./fixtures/source-documents.ts";
import { runHistoryDatabase } from "./fixtures/reply-history-database.ts";

const uuid = Schema.decodeUnknownSync(Uuid);
const id = {
  user: uuid("40000000-0000-4000-8000-000000000001"),
  vault: uuid("40000000-0000-4000-8000-000000000002"),
  membership: uuid("40000000-0000-4000-8000-000000000003"),
  run: uuid("40000000-0000-4000-8000-000000000004"),
  rerun: uuid("40000000-0000-4000-8000-000000000005"),
};
const documents = ["Liquidators", "Underground", "Peat"].map((title, index) => ({
  id: uuid(`40000000-0000-4000-8000-0000000001${index}0`),
  title,
  idea: uuid(`40000000-0000-4000-8000-0000000002${index}0`),
}));

const prompt = (name: string) =>
  readFile(new URL(`../src/default_prompts/${name}.md`, import.meta.url), "utf8").then((text) =>
    text.trim(),
  );
const settings = {
  model: "deepseek/deepseek-v3.2",
  proposePrompt: await prompt("propose_topics"),
  judgePrompt: await prompt("judge_same_topic"),
  concurrency: 4,
  pivotsInFlight: 8,
  progress: () => Effect.void,
};

const calls: CompleteInput[] = [];
const titleOf = (input: CompleteInput) =>
  /## Doc: (.*)/.exec(String(input.messages[0]?.content))?.[1] ?? "";
const reply = (input: CompleteInput): ModelCompletion => {
  calls.push(input);
  const content = String(input.messages[0]?.content);
  const text = content.includes("## Doc:")
    ? JSON.stringify({
        topics: [
          {
            slug: "topic",
            title:
              titleOf(input) === "Peat" ? "Peat extraction" : "Struggle against liquidationism",
            description: `From ${titleOf(input)}.`,
            inclusion_test: "An idea belongs if it is about this.",
            subsumed_idea_ids: ["idea_1"],
          },
        ],
        set_aside: [],
      })
    : JSON.stringify({ relation: "same", reason: "Same subject." });
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
const unit = (axis: number) =>
  Array.from({ length: 1024 }, (_unused, index) => (index === axis ? 1 : 0));
const embeddings = {
  embed: (texts: readonly string[]) =>
    Effect.succeed(texts.map((text) => (text.startsWith("Peat") ? unit(1) : unit(0)))),
};
const logger = { info: () => Effect.void, warn: () => Effect.void, error: () => Effect.void };

const build = (runId: Uuid) =>
  runHistoryDatabase(
    Effect.gen(function* () {
      const db = yield* Database;
      const runner = yield* makeAskRunner(
        { db, languageModel, logger },
        { vaultId: id.vault, runId },
      );
      const dependencies = { db, embeddings, runner };
      const library = yield* loadLibrary(db, id.vault);
      const proposed = yield* proposeTopics(dependencies, id.vault, library, settings);
      const paired = yield* pairCandidates(db, id.vault);
      const blocks = yield* loadBlocks(db, id.vault, library);
      const { themes, failedJudgments } = yield* groupThemes(
        dependencies,
        id.vault,
        blocks,
        settings,
      );
      const candidates = yield* db.query((d) => d.select().from(topicCandidates));
      return { proposed, paired, themes, failedJudgments, candidates };
    }),
  );

beforeEach(async () => {
  calls.length = 0;
  await runHistoryDatabase(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.query((d) => d.delete(users));
      yield* db.query((d) => d.insert(users).values({ id: id.user, email: "themes@example.com" }));
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.insert(vaults).values({ id: id.vault, name: "Themes", ownerId: id.user });
          yield* tx
            .insert(vaultMemberships)
            .values({ id: id.membership, vaultId: id.vault, userId: id.user, role: "EDITOR" });
          yield* seedLegacySources(
            tx,
            documents.map((document) => ({
              id: document.id,
              vaultId: id.vault,
              filePath: `raw/${document.title}.md`,
              fileHash: `file-${document.title}`,
              bodyHash: `body-${document.title}`,
              sourceType: "document",
              title: document.title,
            })),
          );
          yield* tx.insert(ideas).values(
            documents.map((document) => ({
              ideaId: document.idea,
              vaultId: id.vault,
              documentId: document.id,
              kind: "concept",
              label: document.title,
              description: `About ${document.title}`,
            })),
          );
          yield* tx.insert(anchors).values(
            documents.map((document) => ({
              ideaId: document.idea,
              position: 0,
              claim: `${document.title} claim`,
              quote: "q",
            })),
          );
        }),
      );
    }),
  );
});

describe("themes from per-document topics", () => {
  it("proposes topics per document, pairs only similar topics from different documents, and joins the same ones", async () => {
    const first = await build(id.run);
    expect(first.proposed).toEqual({ documents: 3, failedDocuments: 0, newTopics: 3 });
    expect(first.failedJudgments).toBe(0);
    expect(first.candidates).toHaveLength(1);
    expect(first.themes).toHaveLength(2);
    const joined = first.themes.find((theme) => theme.members.length === 2);
    expect(joined?.title).toBe("Struggle against liquidationism");
    expect(new Set(joined?.documentIds)).toEqual(new Set([documents[0]?.id, documents[1]?.id]));
    expect(new Set(joined?.ideaIds)).toEqual(new Set([documents[0]?.idea, documents[1]?.idea]));
    expect(calls).toHaveLength(4);
  });

  it("asks nothing and stores nothing again when nothing changed", async () => {
    const first = await build(id.run);
    calls.length = 0;
    const again = await build(id.rerun);
    expect(calls).toHaveLength(0);
    expect(again.proposed.newTopics).toBe(0);
    expect(again.paired.paired).toBe(0);
    expect(again.themes.map((theme) => [...theme.members].sort())).toEqual(
      first.themes.map((theme) => [...theme.members].sort()),
    );
  });

  it("drops a document's old topics when its proposal question changes", async () => {
    await build(id.run);
    await runHistoryDatabase(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db.query((d) =>
          d.insert(anchors).values({
            ideaId: documents[2]?.idea ?? id.run,
            position: 1,
            claim: "New claim",
            quote: "q",
          }),
        );
      }),
    );
    calls.length = 0;
    const after = await build(id.rerun);
    expect(calls).toHaveLength(1);
    expect(after.proposed.newTopics).toBe(1);
    const stored = await runHistoryDatabase(
      Effect.gen(function* () {
        const db = yield* Database;
        return yield* db.query((d) => d.select().from(topicProposals));
      }),
    );
    expect(stored).toHaveLength(3);
  });
});

describe("pivot grouping", () => {
  const hash = (text: string) => createHash("sha256").update(text).digest().readUInt32BE(0);
  const sequential = (
    order: readonly string[],
    neighbours: ReadonlyMap<string, readonly string[]>,
    same: (a: string, b: string) => boolean,
  ) => {
    const leader = new Map<string, string>();
    for (const node of order) {
      if (leader.has(node)) continue;
      leader.set(node, node);
      for (const other of neighbours.get(node) ?? [])
        if (!leader.has(other) && same(node, other)) leader.set(other, node);
    }
    return leader;
  };

  it("matches the one-at-a-time procedure whatever order the answers arrive in", async () => {
    for (let trial = 0; trial < 60; trial += 1) {
      const n = 20 + (hash(`n${trial}`) % 120);
      const nodes = Array.from({ length: n }, (_unused, index) => `t${trial}-${index}`);
      const order = nodes.toSorted((left, right) => hash(left) - hash(right));
      const lists = new Map(nodes.map((node) => [node, new Set<string>()]));
      for (const node of nodes) {
        for (let k = 0; k < 1 + (hash(`d${trial}`) % 6); k += 1) {
          const other = nodes[hash(`${node}:${k}`) % n] ?? node;
          if (other === node) continue;
          lists.get(node)?.add(other);
          lists.get(other)?.add(node);
        }
      }
      const neighbours = new Map([...lists].map(([node, set]) => [node, [...set].sort()]));
      const rate = hash(`s${trial}`) % 100;
      const same = (a: string, b: string) => hash(a < b ? `${a}|${b}` : `${b}|${a}`) % 100 < rate;
      const leader = await Effect.runPromise(
        pivotGroups(
          order,
          neighbours,
          (pivot, open) =>
            Effect.sleep(`${hash(`${pivot}:delay`) % 4} millis`).pipe(
              Effect.as(open.filter((other) => same(pivot, other))),
            ),
          1 + (hash(`m${trial}`) % 8),
          () => Effect.void,
        ),
      );
      expect(Object.fromEntries(leader)).toEqual(
        Object.fromEntries(sequential(order, neighbours, same)),
      );
    }
  });
});
