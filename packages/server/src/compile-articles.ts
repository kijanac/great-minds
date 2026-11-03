import { type Database, topicProposals } from "@great-minds/database";
import { Uuid } from "@great-minds/domain";
import { sql } from "drizzle-orm";
import { Effect, Schema, Semaphore } from "effect";

import type { AskRunner, Progress } from "./compile-asks.ts";
import { loadBlocks, pivotGroups, responseFormat, type Theme } from "./compile-themes.ts";
import { contentHash } from "./crypto.ts";

const ARTICLE_MIN_DOCUMENTS = 5;
const MERGE_MAX_DISTANCE = 0.35;
const PLACE_MAX_DISTANCE = 0.4;
const PLACE_CANDIDATES = 3;
const PLACE_NEAREST_THEMES = 20;
const SAMPLE_MEMBERS = 5;
const SAMPLE_IDEAS = 2;

export const SameEntryAnswer = Schema.Struct({
  relation: Schema.Literals(["same", "related", "unrelated"] as const),
  reason: Schema.String,
});

export const PlacementAnswer = Schema.Struct({
  verdict: Schema.Literals(["yes", "no"] as const),
  reason: Schema.String,
});

const PairRows = Schema.Struct({
  rows: Schema.Array(Schema.Struct({ a: Uuid, b: Uuid })),
});

export type ArticleSettings = {
  readonly model: string;
  readonly mergePrompt: string;
  readonly placePrompt: string;
  readonly concurrency: number;
  readonly pivotsInFlight: number;
  readonly progress: Progress;
};

export type Article = {
  readonly id: Uuid;
  readonly title: string;
  readonly description: string;
  readonly themeIds: readonly Uuid[];
  readonly documentIds: readonly Uuid[];
  readonly ideaIds: readonly Uuid[];
};

const nameKey = (title: string) =>
  title
    .toLowerCase()
    .replace(/[–—]/g, "-")
    .replace(/^the /, "")
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

export const buildArticles = (
  dependencies: { readonly db: Database["Service"]; readonly runner: AskRunner },
  vaultId: Uuid,
  themes: readonly Theme[],
  settings: ArticleSettings,
) =>
  Effect.gen(function* () {
    const { db, runner } = dependencies;
    const { proposals, blocks, ideaById, claimsOf } = yield* loadBlocks(db, vaultId);
    const proposalById = new Map(proposals.map((proposal) => [proposal.id, proposal]));
    const orderKey = (id: Uuid) => {
      const proposal = proposalById.get(id);
      return proposal === undefined ? id : contentHash(proposal.askKey, String(proposal.position));
    };
    const byOrder = (left: Uuid, right: Uuid) => (orderKey(left) < orderKey(right) ? -1 : 1);
    const big = themes.filter((theme) => theme.documentIds.length >= ARTICLE_MIN_DOCUMENTS);
    const small = themes.filter((theme) => theme.documentIds.length < ARTICLE_MIN_DOCUMENTS);
    const themeById = new Map(themes.map((theme) => [theme.id, theme]));
    const bigIds = big.map((theme) => theme.id);

    const sampleBlock = (theme: Theme) => {
      const founding = proposalById.get(theme.id);
      const sample = theme.members.toSorted(byOrder).slice(0, SAMPLE_MEMBERS);
      const lines = [
        `Name: ${founding?.title ?? theme.title}`,
        `Description: ${founding?.description ?? theme.description}`,
        `Topics in it include: ${sample.map((member) => `"${proposalById.get(member)?.title ?? ""}"`).join("; ")}`,
        "Ideas placed under those topics, with the documents' claims:",
      ];
      for (const member of sample) {
        const ideaIds = (proposalById.get(member)?.ideaIds ?? []).toSorted((left, right) =>
          contentHash(left) < contentHash(right) ? -1 : 1,
        );
        for (const ideaId of ideaIds.slice(0, SAMPLE_IDEAS)) {
          const idea = ideaById.get(ideaId);
          if (idea === undefined) continue;
          lines.push(`- [${idea.kind}] ${idea.label}: ${idea.description}`);
          const claim = claimsOf.get(ideaId)?.[0];
          if (claim !== undefined) lines.push(`  - claim: ${claim}`);
        }
      }
      return lines.join("\n");
    };

    const mergePairs =
      bigIds.length < 2
        ? { rows: [] }
        : yield* db
            .query((d) =>
              d.execute(sql`
                select a.id as a, b.id as b
                from ${topicProposals} a
                join ${topicProposals} b on b.id > a.id
                where a.id = any(${sql.param(bigIds)}::uuid[])
                  and b.id = any(${sql.param(bigIds)}::uuid[])
                  and (a.embedding <=> b.embedding) <= ${MERGE_MAX_DISTANCE}
                order by a.embedding <=> b.embedding, a.id, b.id`),
            )
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(PairRows)), Effect.orDie);
    const neighbours = new Map<Uuid, Uuid[]>();
    for (const { a, b } of mergePairs.rows) {
      neighbours.set(a, [...(neighbours.get(a) ?? []), b]);
      neighbours.set(b, [...(neighbours.get(b) ?? []), a]);
    }

    const permits = yield* Semaphore.make(settings.concurrency);
    let failedQuestions = 0;
    yield* runner.preloadKind("same_entry");
    yield* runner.preloadKind("place_in_article");
    const sampleOf = new Map(big.map((theme) => [theme.id, sampleBlock(theme)]));
    const judgeMerge = (pivot: Uuid, open: readonly Uuid[]) =>
      Effect.forEach(
        open,
        (candidate) =>
          runner
            .ask({
              kind: "same_entry",
              model: settings.model,
              messages: [
                {
                  role: "user",
                  content: settings.mergePrompt
                    .replace("{topic_a}", () => sampleOf.get(pivot) ?? "")
                    .replace("{topic_b}", () => sampleOf.get(candidate) ?? ""),
                },
              ],
              temperature: 0,
              responseFormat: responseFormat("topic_relation", SameEntryAnswer),
              answer: SameEntryAnswer,
            })
            .pipe(
              Semaphore.withPermit(permits),
              Effect.map((answer): readonly Uuid[] =>
                answer.relation === "same" ? [candidate] : [],
              ),
              Effect.catchTag("AskFailed", () =>
                Effect.sync((): readonly Uuid[] => {
                  failedQuestions += 1;
                  return [];
                }),
              ),
            ),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((joined) => joined.flat()));
    const report = (done: number) => settings.progress("build_articles", done, themes.length);
    yield* report(0);
    const merged = yield* pivotGroups(
      bigIds.toSorted(byOrder),
      neighbours,
      judgeMerge,
      settings.pivotsInFlight,
      report,
    );
    let placedCount = big.length;

    const parent = new Map<Uuid, Uuid>();
    const find = (id: Uuid): Uuid => {
      let current = id;
      while (true) {
        const next = parent.get(current);
        if (next === undefined) return current;
        current = next;
      }
    };
    const union = (left: Uuid, right: Uuid) => {
      const [a, b] = [find(left), find(right)];
      if (a === b) return;
      if (byOrder(a, b) < 0) parent.set(b, a);
      else parent.set(a, b);
    };
    for (const theme of big) union(theme.id, merged.get(theme.id) ?? theme.id);
    const firstWithName = new Map<string, Uuid>();
    for (const theme of big.toSorted((left, right) => byOrder(left.id, right.id))) {
      const key = nameKey(theme.title);
      const earlier = firstWithName.get(key);
      if (earlier === undefined) firstWithName.set(key, theme.id);
      else union(earlier, theme.id);
    }
    const groups = new Map<Uuid, Theme[]>();
    for (const theme of big) {
      const root = find(theme.id);
      groups.set(root, [...(groups.get(root) ?? []), theme]);
    }
    const headOf = (members: readonly Theme[]) =>
      members.toSorted(
        (left, right) =>
          right.documentIds.length - left.documentIds.length || byOrder(left.id, right.id),
      )[0];
    const articleOfTheme = new Map<Uuid, Uuid>();
    const heads = new Map<Uuid, Theme>();
    for (const members of groups.values()) {
      const head = headOf(members);
      if (head === undefined) continue;
      heads.set(head.id, head);
      for (const theme of members) articleOfTheme.set(theme.id, head.id);
    }

    const smallIds = small.map((theme) => theme.id);
    const nearest =
      smallIds.length === 0 || bigIds.length === 0
        ? { rows: [] }
        : yield* db
            .query((d) =>
              d.execute(sql`
                select s.id as a, c.id as b
                from ${topicProposals} s
                cross join lateral (
                  select b.id, b.embedding <=> s.embedding as distance
                  from ${topicProposals} b
                  where b.id = any(${sql.param(bigIds)}::uuid[])
                    and (b.embedding <=> s.embedding) <= ${PLACE_MAX_DISTANCE}
                  order by b.embedding <=> s.embedding, b.id
                  limit ${PLACE_NEAREST_THEMES}
                ) c
                where s.id = any(${sql.param(smallIds)}::uuid[])
                order by s.id, c.distance, c.id`),
            )
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(PairRows)), Effect.orDie);
    const candidateArticles = new Map<Uuid, Uuid[]>();
    for (const { a, b } of nearest.rows) {
      const article = articleOfTheme.get(b);
      if (article === undefined) continue;
      const list = candidateArticles.get(a) ?? [];
      if (list.length < PLACE_CANDIDATES && !list.includes(article)) list.push(article);
      candidateArticles.set(a, list);
    }
    const articleBlock = (head: Uuid) => {
      const theme = heads.get(head);
      return `Title: ${theme?.title ?? ""}\nDescription: ${theme?.description ?? ""}`;
    };
    const placements = yield* Effect.forEach(
      small,
      (theme) =>
        Effect.gen(function* () {
          for (const article of candidateArticles.get(theme.id) ?? []) {
            const answer = yield* runner
              .ask({
                kind: "place_in_article",
                model: settings.model,
                messages: [
                  {
                    role: "user",
                    content: settings.placePrompt
                      .replace("{topic_a}", () => blocks.get(theme.id) ?? "")
                      .replace("{topic_b}", () => articleBlock(article)),
                  },
                ],
                temperature: 0,
                responseFormat: responseFormat("theme_attach", PlacementAnswer),
                answer: PlacementAnswer,
              })
              .pipe(
                Semaphore.withPermit(permits),
                Effect.catchTag("AskFailed", () =>
                  Effect.sync(() => {
                    failedQuestions += 1;
                    return undefined;
                  }),
                ),
              );
            if (answer?.verdict === "yes") return [theme.id, article] as const;
          }
          return undefined;
        }).pipe(
          Effect.tap(() =>
            Effect.suspend(() => {
              placedCount += 1;
              return report(placedCount);
            }),
          ),
        ),
      { concurrency: settings.concurrency },
    );
    for (const placement of placements) {
      if (placement !== undefined) articleOfTheme.set(placement[0], placement[1]);
    }

    const themesOf = new Map<Uuid, Uuid[]>();
    for (const [theme, article] of articleOfTheme)
      themesOf.set(article, [...(themesOf.get(article) ?? []), theme]);
    const articles = [...heads.values()].map((head): Article => {
      const themeIds = (themesOf.get(head.id) ?? []).toSorted(byOrder);
      const members = themeIds.flatMap((id) => themeById.get(id) ?? []);
      return {
        id: head.id,
        title: head.title,
        description: head.description,
        themeIds,
        documentIds: [...new Set(members.flatMap((theme) => theme.documentIds))].toSorted(),
        ideaIds: [...new Set(members.flatMap((theme) => theme.ideaIds))].toSorted(),
      };
    });
    return {
      articles: articles.toSorted((left, right) => byOrder(left.id, right.id)),
      placedThemes: placements.filter((placement) => placement !== undefined).length,
      unplacedThemes: placements.filter((placement) => placement === undefined).length,
      failedQuestions,
    };
  });
