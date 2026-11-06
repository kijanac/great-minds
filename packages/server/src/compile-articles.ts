import { type Database, topicProposals } from "@great-minds/database";
import { Uuid } from "@great-minds/domain";
import { sql } from "drizzle-orm";
import { Effect, Schema, Semaphore } from "effect";

import type { AskRunner, Progress } from "./compile-asks.ts";
import { append } from "./collections.ts";
import { type Blocks, pivotGroups, responseFormat, type Theme } from "./compile-themes.ts";
import { contentHash } from "./crypto.ts";

const ARTICLE_MIN_DOCUMENTS = 5;
const MERGE_MAX_DISTANCE = 0.35;
const PLACE_MAX_DISTANCE = 0.4;
const PLACE_CANDIDATES = 3;
const PLACE_NEAREST_THEMES = 20;
const SAMPLE_MEMBERS = 5;
const SAMPLE_IDEAS = 2;
const MERGE_NEAREST = 3;

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
  readonly temperature: number | undefined;
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
  loaded: Blocks,
  themes: readonly Theme[],
  settings: ArticleSettings,
) =>
  Effect.gen(function* () {
    const { db, runner } = dependencies;
    const { proposals, blocks, ideaById, claimsOf } = loaded;
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

    const ideaLines = (topics: readonly Uuid[], shown: number) =>
      topics.slice(0, shown).flatMap((topic) =>
        (proposalById.get(topic)?.ideaIds ?? [])
          .toSorted((left, right) => (contentHash(left) < contentHash(right) ? -1 : 1))
          .slice(0, SAMPLE_IDEAS)
          .flatMap((ideaId) => {
            const idea = ideaById.get(ideaId);
            if (idea === undefined) return [];
            const claim = claimsOf.get(ideaId)?.[0];
            return [
              `- [${idea.kind}] ${idea.label}: ${idea.description}`,
              ...(claim === undefined ? [] : [`  - claim: ${claim}`]),
            ];
          }),
      );
    const describe = (lead: Theme, topics: readonly Uuid[], shown: number) => {
      const founding = proposalById.get(lead.id);
      return [
        `Name: ${founding?.title ?? lead.title}`,
        `Description: ${founding?.description ?? lead.description}`,
        `Topics in it include: ${topics.map((topic) => `"${proposalById.get(topic)?.title ?? ""}"`).join("; ")}`,
        "Ideas placed under those topics, with the documents' claims:",
        ...ideaLines(topics, shown),
      ].join("\n");
    };
    const sampleBlock = (theme: Theme) => {
      const sample = theme.members.toSorted(byOrder).slice(0, SAMPLE_MEMBERS);
      return describe(theme, sample, SAMPLE_MEMBERS);
    };

    const candidates =
      bigIds.length < 2
        ? { rows: [] }
        : yield* db
            .query((d) =>
              d.execute(sql`
                with big as (
                  select id, embedding from ${topicProposals} where id = any(${sql.param(bigIds)}::uuid[])
                ),
                within as (
                  select a.id as a, b.id as b, a.embedding <=> b.embedding as distance
                  from big a join big b on b.id > a.id
                  where (a.embedding <=> b.embedding) <= ${MERGE_MAX_DISTANCE}
                ),
                nearest as (
                  select least(s.id, c.id) as a, greatest(s.id, c.id) as b, c.distance
                  from big s
                  cross join lateral (
                    select n.id, n.embedding <=> s.embedding as distance
                    from big n
                    where n.id <> s.id
                    order by n.embedding <=> s.embedding, n.id
                    limit ${MERGE_NEAREST}
                  ) c
                )
                select a, b
                from (select * from within union all select * from nearest) pairs
                group by a, b
                order by min(distance), a, b`),
            )
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(PairRows)), Effect.orDie);
    const neighbours = new Map<Uuid, Uuid[]>();
    for (const { a, b } of candidates.rows) {
      append(neighbours, a, b);
      append(neighbours, b, a);
    }

    const permits = yield* Semaphore.make(settings.concurrency);
    let failedQuestions = 0;
    yield* runner.preloadKind("same_entry");
    yield* runner.preloadKind("place_in_article");
    const sameEntry = (blockA: string, blockB: string) =>
      runner
        .ask({
          kind: "same_entry",
          model: settings.model,
          messages: [
            {
              role: "user",
              content: settings.mergePrompt
                .replace("{topic_a}", () => blockA)
                .replace("{topic_b}", () => blockB),
            },
          ],
          temperature: settings.temperature,
          responseFormat: responseFormat("topic_relation", SameEntryAnswer),
          answer: SameEntryAnswer,
        })
        .pipe(
          Semaphore.withPermit(permits),
          Effect.map((answer) => answer.relation === "same"),
          Effect.catchTag("AskFailed", () =>
            Effect.sync(() => {
              failedQuestions += 1;
              return false;
            }),
          ),
        );
    const sampleOf = new Map(big.map((theme) => [theme.id, sampleBlock(theme)]));
    const judgeMerge = (pivot: Uuid, open: readonly Uuid[]) =>
      Effect.forEach(
        open,
        (candidate) =>
          sameEntry(sampleOf.get(pivot) ?? "", sampleOf.get(candidate) ?? "").pipe(
            Effect.map((same): readonly Uuid[] => (same ? [candidate] : [])),
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
    const headOf = (members: readonly Theme[]) =>
      members.toSorted(
        (left, right) =>
          right.documentIds.length - left.documentIds.length || byOrder(left.id, right.id),
      )[0];
    const groups = new Map<Uuid, Theme[]>();
    for (const theme of big) append(groups, find(theme.id), theme);
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
                temperature: settings.temperature,
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
    for (const [theme, article] of articleOfTheme) append(themesOf, article, theme);
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
