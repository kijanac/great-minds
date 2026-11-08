import { readFile } from "node:fs/promises";

import {
  anchors,
  Database,
  ideas,
  sourceDocuments,
  users,
  vaultMemberships,
  vaults,
} from "@great-minds/database";
import { Uuid } from "@great-minds/domain";
import { eq } from "drizzle-orm";
import { Effect, Schema, Stream } from "effect";
import { beforeEach, describe, expect, it } from "vitest";

import type { Article } from "../src/compile-articles.ts";
import { makeAskRunner } from "../src/compile-asks.ts";
import { writeArticles } from "../src/compile-write.ts";
import { type CompleteInput, type ModelCompletion, ModelProviderError } from "../src/llm.ts";
import { seedLegacySources } from "./fixtures/source-documents.ts";
import { runHistoryDatabase } from "./fixtures/reply-history-database.ts";

const uuid = Schema.decodeUnknownSync(Uuid);
const id = {
  user: uuid("80000000-0000-4000-8000-000000000001"),
  vault: uuid("80000000-0000-4000-8000-000000000002"),
  membership: uuid("80000000-0000-4000-8000-000000000003"),
  document: uuid("80000000-0000-4000-8000-000000000010"),
  first: uuid("80000000-0000-4000-8000-000000000020"),
  second: uuid("80000000-0000-4000-8000-000000000021"),
  article: uuid("80000000-0000-4000-8000-000000000030"),
};
const runs = Array.from({ length: 4 }, (_unused, index) =>
  uuid(`80000000-0000-4000-8000-00000000004${index}`),
);
const article: Article = {
  id: id.article,
  title: "Struggle against liquidationism",
  description: "The fight to keep the illegal party.",
  themeIds: [id.article],
  documentIds: [id.document],
  ideaIds: [id.second, id.first],
};
const settings = {
  model: "z-ai/glm-5.3",
  prompt: await readFile(
    new URL("../src/default_prompts/write_article.md", import.meta.url),
    "utf8",
  ).then((text) => text.trim()),
  temperature: 0.3,
  reasoningEffort: "high" as const,
  concurrency: 2,
  progress: () => Effect.void,
};

const calls: CompleteInput[] = [];
let nextBody =
  "# Liquidationism\n\nThe liquidators gave up the underground [^2] and lost [^9]. Lenin held on [^1] [^2].";
const reply = (input: CompleteInput): ModelCompletion => {
  calls.push(input);
  return {
    text: JSON.stringify({
      body: nextBody,
      tags: ["Liquidationism", "liquidationism", "RSDLP 1908"],
    }),
    finishReason: "stop",
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150, cost: 0.01 },
  };
};
const languageModel = {
  streamChat: () => Stream.empty,
  complete: (input: CompleteInput) => Effect.sync(() => reply(input)),
};
const logger = { info: () => Effect.void, warn: () => Effect.void, error: () => Effect.void };

const write = (runId: Uuid) =>
  runHistoryDatabase(
    Effect.gen(function* () {
      const db = yield* Database;
      const runner = yield* makeAskRunner(
        { db, languageModel, logger },
        { vaultId: id.vault, runId },
      );
      return yield* writeArticles({ db, runner }, id.vault, [article], settings);
    }),
  );

beforeEach(async () => {
  calls.length = 0;
  nextBody =
    "# Liquidationism\n\nThe liquidators gave up the underground [^2] and lost [^9]. Lenin held on [^1] [^2].";
  await runHistoryDatabase(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.query((d) => d.delete(users));
      yield* db.query((d) => d.insert(users).values({ id: id.user, email: "write@example.com" }));
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.insert(vaults).values({ id: id.vault, name: "Write", ownerId: id.user });
          yield* tx
            .insert(vaultMemberships)
            .values({ id: id.membership, vaultId: id.vault, userId: id.user, role: "EDITOR" });
          yield* seedLegacySources(tx, {
            id: id.document,
            vaultId: id.vault,
            filePath: "raw/liquidators.md",
            fileHash: "file",
            bodyHash: "body",
            sourceType: "document",
            title: "The Liquidators",
            publishedDate: "1909",
          });
          yield* tx.insert(ideas).values([
            {
              ideaId: id.first,
              vaultId: id.vault,
              documentId: id.document,
              kind: "concept",
              label: "Liquidationism",
              description: "Giving up the illegal party",
            },
            {
              ideaId: id.second,
              vaultId: id.vault,
              documentId: id.document,
              kind: "event",
              label: "Party conference",
              description: "The 1908 conference",
            },
          ]);
          yield* tx.insert(anchors).values([
            {
              ideaId: id.first,
              position: 0,
              claim: "The liquidators wanted a legal party.",
              quote: "a legal party",
              chunkIndex: 3,
            },
            {
              ideaId: id.second,
              position: 0,
              claim: "The conference condemned them.",
              quote: "condemned",
              chunkIndex: null,
            },
          ]);
        }),
      );
    }),
  );
});

describe("writing articles", () => {
  it("sends only the article's own content and builds footnotes from the cited anchors", async () => {
    const result = await write(runs[0] ?? id.article);
    const prompt = String(calls[0]?.messages[0]?.content);
    expect(prompt).toContain("Title: Struggle against liquidationism");
    expect(prompt).toContain("[^1] claim: The liquidators wanted a legal party.");
    expect(prompt).toContain("Source: The Liquidators (1909)");
    expect(prompt).not.toContain("raw/liquidators.md");
    expect(prompt).not.toContain("wiki/");
    expect(calls[0]?.reasoningEffort).toBe("high");
    expect(result.failedArticles).toEqual({ failed: [], setAside: [] });
    expect(result.articles[0]?.tags).toEqual(["liquidationism", "rsdlp-1908"]);
    expect(result.articles[0]?.markdown).toBe(
      [
        "# Liquidationism",
        "",
        "The liquidators gave up the underground [^1] and lost. Lenin held on [^2] [^1].",
        "",
        "---",
        "",
        '[^1]: [The Liquidators (1909)](raw/liquidators.md) — "condemned"',
        '[^2]: [The Liquidators (1909)](raw/liquidators.md#^p3) — "a legal party"',
        "",
      ].join("\n"),
    );
  });

  it("reuses the saved text when nothing changed and points footnotes at the source's current path", async () => {
    await write(runs[0] ?? id.article);
    await runHistoryDatabase(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db.query((d) =>
          d
            .update(sourceDocuments)
            .set({ filePath: "raw/moved/liquidators.md" })
            .where(eq(sourceDocuments.id, id.document)),
        );
      }),
    );
    calls.length = 0;
    const again = await write(runs[1] ?? id.article);
    expect(calls).toHaveLength(0);
    expect(again.articles[0]?.markdown).toContain("(raw/moved/liquidators.md#^p3)");
  });

  it("does not save a reply without a heading, so the next run asks again", async () => {
    nextBody = "Just prose, no heading.";
    const failed = await write(runs[2] ?? id.article);
    expect(failed).toEqual({
      articles: [],
      failedArticles: { failed: ["Struggle against liquidationism"], setAside: [] },
    });
    nextBody = "# Liquidationism\n\nFixed [^1].";
    const retried = await write(runs[3] ?? id.article);
    expect(calls).toHaveLength(2);
    expect(retried.failedArticles).toEqual({ failed: [], setAside: [] });
  });

  it("sets an article aside after three failed attempts on the same input, until it changes", async () => {
    nextBody = "Just prose, no heading.";
    for (const attempt of [0, 1, 2]) {
      const failed = await write(runs[attempt] ?? id.article);
      expect(failed.failedArticles).toEqual({
        failed: ["Struggle against liquidationism"],
        setAside: [],
      });
    }
    expect(calls).toHaveLength(3);

    nextBody = "# Liquidationism\n\nFixed [^1].";
    const skipped = await write(runs[3] ?? id.article);
    expect(calls).toHaveLength(3);
    expect(skipped.failedArticles).toEqual({
      failed: [],
      setAside: ["Struggle against liquidationism"],
    });

    const changed = await runHistoryDatabase(
      Effect.gen(function* () {
        const db = yield* Database;
        const runner = yield* makeAskRunner(
          { db, languageModel, logger },
          { vaultId: id.vault, runId: runs[3] ?? id.article },
        );
        return yield* writeArticles(
          { db, runner },
          id.vault,
          [{ ...article, description: "The fight to keep the illegal party, revised." }],
          settings,
        );
      }),
    );
    expect(calls).toHaveLength(4);
    expect(changed.failedArticles).toEqual({ failed: [], setAside: [] });
  });

  it("does not count provider errors toward setting an article aside", async () => {
    const failing = {
      streamChat: () => Stream.empty,
      complete: () => Effect.fail(new ModelProviderError({ message: "provider down" })),
    };
    for (const attempt of [0, 1, 2, 3]) {
      const result = await runHistoryDatabase(
        Effect.gen(function* () {
          const db = yield* Database;
          const runner = yield* makeAskRunner(
            { db, languageModel: failing, logger },
            { vaultId: id.vault, runId: runs[attempt] ?? id.article },
          );
          return yield* writeArticles({ db, runner }, id.vault, [article], settings);
        }),
      );
      expect(result.failedArticles).toEqual({
        failed: ["Struggle against liquidationism"],
        setAside: [],
      });
    }
    const recovered = await write(runs[0] ?? id.article);
    expect(recovered.failedArticles).toEqual({ failed: [], setAside: [] });
  });
});
