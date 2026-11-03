import type { Uuid } from "@great-minds/domain";
import { Effect, Schema } from "effect";

import { Buffer } from "node:buffer";

import { append } from "./collections.ts";
import type { AskFailed, AskRunner, Progress } from "./compile-asks.ts";
import { contentHash } from "./crypto.ts";
import type { ArticleContent } from "./compile-write.ts";
import { responseFormat } from "./compile-themes.ts";
import type { EmbeddingsService } from "./embeddings.ts";

const CANDIDATES = 5;
const RRF_K = 60;
const EMBEDDING_BATCH = 50;

const MentionList = Schema.Struct({
  mentions: Schema.Array(Schema.Struct({ phrase: Schema.String, about: Schema.String })),
});
const Pick = Schema.Struct({ choice: Schema.Int });
const Check = Schema.Struct({ verdict: Schema.Literals(["yes", "no"] as const) });

export type LinkSettings = {
  readonly pickModel: string;
  readonly checkModel: string;
  readonly mentionPrompt: string;
  readonly pickPrompt: string;
  readonly checkPrompt: string;
  readonly embeddingModel: string;
  readonly concurrency: number;
  readonly progress: Progress;
};

export type ArticleText = { readonly id: Uuid; readonly body: string };

export type Link = { readonly phrase: string; readonly target: Uuid };

const proseOf = (body: string) =>
  body
    .replace(/\[\^\d+\]/g, "")
    .replace(/ {2,}/g, " ")
    .trim();

const headingFree = (text: string) => text.replace(/^#.*$/gm, (line) => " ".repeat(line.length));

const sentenceAround = (text: string, start: number, end: number) => {
  const left = Math.max(text.lastIndexOf(". ", start), text.lastIndexOf("\n", start));
  const ends = [text.indexOf(". ", end), text.indexOf("\n", end)].filter((at) => at !== -1);
  const right = ends.length === 0 ? text.length : Math.min(...ends) + 1;
  return text.slice(left + 1, right).trim();
};

const words = (text: string) =>
  (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((word) => word.length > 2);

const weighted = (tokens: readonly string[], idf: ReadonlyMap<string, number>) => {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  const weights = new Map<string, number>();
  for (const [token, count] of counts)
    weights.set(token, (1 + Math.log(count)) * (idf.get(token) ?? 0));
  const norm = Math.sqrt([...weights.values()].reduce((sum, value) => sum + value * value, 0)) || 1;
  for (const [token, value] of weights) weights.set(token, value / norm);
  return weights;
};

const normalized = (vector: readonly number[]) => {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return Float32Array.from(vector, (value) => value / norm);
};

const toBase64 = (vector: Float32Array) =>
  Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString("base64");

const fromBase64 = (text: string) =>
  new Float32Array(Uint8Array.from(Buffer.from(text, "base64")).buffer);

const dot = (left: Float32Array, right: Float32Array) => {
  let total = 0;
  for (let index = 0; index < left.length; index += 1)
    total += (left[index] ?? 0) * (right[index] ?? 0);
  return total;
};

export const withLinks = (
  markdown: string,
  links: readonly Link[],
  hrefOf: (target: Uuid) => string | undefined,
) => {
  const split = markdown.indexOf("\n\n---\n\n");
  const prose = split === -1 ? markdown : markdown.slice(0, split);
  const searchable = headingFree(prose);
  const spans: { start: number; end: number; href: string }[] = [];
  for (const link of links) {
    const href = hrefOf(link.target);
    if (href === undefined) continue;
    const start = searchable.indexOf(link.phrase);
    if (start === -1) continue;
    const end = start + link.phrase.length;
    if (spans.some((span) => start < span.end && span.start < end)) continue;
    spans.push({ start, end, href });
  }
  let linked = prose;
  for (const span of spans.toSorted((left, right) => right.start - left.start))
    linked = `${linked.slice(0, span.start)}[${linked.slice(span.start, span.end)}](${span.href})${linked.slice(span.end)}`;
  return split === -1 ? linked : `${linked}${markdown.slice(split)}`;
};

export const findLinks = (
  dependencies: {
    readonly embeddings: EmbeddingsService["Service"];
    readonly runner: AskRunner;
  },
  catalogue: readonly Pick<ArticleContent, "id" | "title" | "description">[],
  texts: readonly ArticleText[],
  settings: LinkSettings,
) =>
  Effect.gen(function* () {
    const { embeddings, runner } = dependencies;
    const articleById = new Map(catalogue.map((article) => [article.id, article]));
    yield* runner.preloadKind("find_mentions");
    yield* runner.preloadKind("pick_link_target");
    yield* runner.preloadKind("check_link");
    yield* runner.preloadKind("embed");
    let failedQuestions = 0;
    const counted = <A>(effect: Effect.Effect<A, AskFailed>, fallback: A) =>
      effect.pipe(
        Effect.catchTag("AskFailed", () =>
          Effect.sync(() => {
            failedQuestions += 1;
            return fallback;
          }),
        ),
      );

    let checkedCount = 0;
    let checkTotal = texts.length;
    const checked = Effect.suspend(() => {
      checkedCount += 1;
      return settings.progress("link_articles", checkedCount, checkTotal);
    });
    yield* settings.progress("link_articles", 0, checkTotal);
    const mentioned = yield* Effect.forEach(
      texts,
      (text) => {
        const prose = proseOf(text.body.split("\n\n---\n\n")[0] ?? text.body);
        return counted(
          runner
            .ask({
              kind: "find_mentions",
              model: settings.pickModel,
              messages: [
                { role: "user", content: settings.mentionPrompt.replace("{prose}", () => prose) },
              ],
              temperature: 0,
              responseFormat: responseFormat("article_mentions", MentionList),
              answer: MentionList,
            })
            .pipe(
              Effect.map((answer) => {
                const searchable = headingFree(prose);
                const seen = new Set<string>();
                return answer.mentions.flatMap((mention) => {
                  const phrase = mention.phrase.trim();
                  const at = phrase === "" ? -1 : searchable.indexOf(phrase);
                  if (at === -1 || seen.has(phrase.toLowerCase())) return [];
                  seen.add(phrase.toLowerCase());
                  return [
                    {
                      source: text.id,
                      phrase,
                      about: mention.about.trim(),
                      sentence: sentenceAround(prose, at, at + phrase.length),
                    },
                  ];
                });
              }),
            ),
          [],
        ).pipe(Effect.tap(() => checked));
      },
      { concurrency: settings.concurrency },
    ).pipe(Effect.map((lists) => lists.flat()));
    checkTotal += mentioned.length;

    const ids = catalogue.map((article) => article.id);
    const embedAll = (inputs: readonly string[]) =>
      Effect.gen(function* () {
        const keys = inputs.map((input) => contentHash(settings.embeddingModel, input));
        const out: (Float32Array | undefined)[] = [];
        const missing: number[] = [];
        for (const [index, key] of keys.entries()) {
          const saved = yield* runner.recall("embed", key, Schema.String);
          if (saved === undefined) missing.push(index);
          out[index] = saved === undefined ? undefined : fromBase64(saved);
        }
        for (let offset = 0; offset < missing.length; offset += EMBEDDING_BATCH) {
          const batch = missing.slice(offset, offset + EMBEDDING_BATCH);
          const vectors = yield* embeddings.embed(batch.map((index) => inputs[index] ?? ""));
          for (const [position, index] of batch.entries()) {
            const vector = normalized(vectors[position] ?? []);
            out[index] = vector;
            yield* runner.keep("embed", keys[index] ?? "", Schema.String, toBase64(vector));
          }
        }
        return out;
      });
    const catalogueVectors = yield* embedAll(
      catalogue.map((article) => `${article.title}. ${article.description}`),
    );
    const articleVector = new Map(
      catalogue.map((article, index) => [article.id, catalogueVectors[index]] as const),
    );
    const mentionVectors = yield* embedAll(
      mentioned.map((mention) => `${mention.phrase}: ${mention.about}`),
    );
    const documentTokens = new Map(
      catalogue.map((article) => [article.id, words(`${article.title} ${article.description}`)]),
    );
    const frequency = new Map<string, number>();
    for (const tokens of documentTokens.values())
      for (const token of new Set(tokens)) frequency.set(token, (frequency.get(token) ?? 0) + 1);
    const idf = new Map(
      [...frequency].map(([token, count]) => [token, Math.log(catalogue.length / count)]),
    );
    const articleWeights = new Map(
      [...documentTokens].map(([id, tokens]) => [id, weighted(tokens, idf)]),
    );

    const shortlist = (index: number) =>
      Effect.gen(function* () {
        const mention = mentioned[index];
        if (mention === undefined) return [];
        if (index % 100 === 0) yield* Effect.yieldNow;
        const others = ids.filter((id) => id !== mention.source);
        const query = mentionVectors[index];
        const byVector = others
          .map((id) => {
            const vector = articleVector.get(id);
            return [
              id,
              query === undefined || vector === undefined ? 0 : dot(query, vector),
            ] as const;
          })
          .toSorted((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1));
        const queryWeights = weighted(words(`${mention.phrase} ${mention.about}`), idf);
        const byWords = others
          .map((id) => {
            const article = articleWeights.get(id);
            let score = 0;
            for (const [token, value] of queryWeights) score += value * (article?.get(token) ?? 0);
            return [id, score] as const;
          })
          .toSorted((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1));
        const fused = new Map<Uuid, number>();
        for (const ranking of [byVector, byWords])
          ranking.forEach(([id], rank) =>
            fused.set(id, (fused.get(id) ?? 0) + 1 / (RRF_K + rank + 1)),
          );
        return [...fused]
          .toSorted((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1))
          .slice(0, CANDIDATES)
          .map(([id]) => id);
      });

    const found = yield* Effect.forEach(
      mentioned.map((_mention, index) => index),
      (index) =>
        Effect.gen(function* () {
          const mention = mentioned[index];
          if (mention === undefined) return [];
          const candidates = yield* shortlist(index);
          const listing = candidates
            .map((id, position) => {
              const article = articleById.get(id);
              return `${position + 1}. ${article?.title ?? ""} — ${article?.description ?? ""}`;
            })
            .join("\n");
          const pick = yield* counted(
            runner.ask({
              kind: "pick_link_target",
              model: settings.pickModel,
              messages: [
                {
                  role: "user",
                  content: settings.pickPrompt
                    .replace("{sentence}", () => mention.sentence)
                    .replace("{phrase}", () => mention.phrase)
                    .replace("{candidates}", () => listing),
                },
              ],
              temperature: 0,
              responseFormat: responseFormat("link_pick", Pick),
              answer: Pick,
            }),
            { choice: 0 },
          );
          const target = candidates[pick.choice - 1];
          const article = target === undefined ? undefined : articleById.get(target);
          if (target === undefined || article === undefined) return [];
          const check = yield* counted(
            runner.ask({
              kind: "check_link",
              model: settings.checkModel,
              messages: [
                {
                  role: "user",
                  content: settings.checkPrompt
                    .replace("{sentence}", () => mention.sentence)
                    .replace("{phrase}", () => mention.phrase)
                    .replace("{title}", () => article.title)
                    .replace("{description}", () => article.description),
                },
              ],
              responseFormat: responseFormat("link_check", Check),
              answer: Check,
            }),
            { verdict: "no" as const },
          );
          return check.verdict === "yes"
            ? [{ source: mention.source, link: { phrase: mention.phrase, target } }]
            : [];
        }).pipe(Effect.tap(() => checked)),
      { concurrency: settings.concurrency },
    ).pipe(Effect.map((lists) => lists.flat()));

    const linksOf = new Map<Uuid, Link[]>();
    for (const { source, link } of found) append(linksOf, source, link);
    return { linksOf, mentions: mentioned.length, links: found.length, failedQuestions };
  });
