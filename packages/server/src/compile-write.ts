import { anchors, type Database, ideas, inUuidArray, sourceDocuments } from "@great-minds/database";
import type { Uuid } from "@great-minds/domain";
import { asc, eq } from "drizzle-orm";
import { Effect, Schema } from "effect";

import { append } from "./collections.ts";
import type { AskRunner, Progress } from "./compile-asks.ts";
import type { ReasoningEffort } from "./config.ts";
import { responseFormat } from "./compile-themes.ts";

const ArticleBody = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((body) => {
      const trimmed = body.trim();
      return trimmed.length > 0 && !trimmed.startsWith("---") && /^# /m.test(trimmed);
    }),
  ),
);

export const WrittenArticle = Schema.Struct({
  body: ArticleBody,
  tags: Schema.Array(Schema.String),
});

export type ArticleContent = {
  readonly id: Uuid;
  readonly title: string;
  readonly description: string;
  readonly ideaIds: readonly Uuid[];
};

export type WriterSettings = {
  readonly model: string;
  readonly prompt: string;
  readonly temperature: number | undefined;
  readonly reasoningEffort: ReasoningEffort | undefined;
  readonly concurrency: number;
  readonly progress: Progress;
};

export type PublishedArticle = {
  readonly id: Uuid;
  readonly markdown: string;
  readonly tags: readonly string[];
};

type Source = {
  readonly title: string | null;
  readonly publishedDate: string | null;
  readonly filePath: string;
};

type Numbered = {
  readonly number: number;
  readonly ideaId: Uuid;
  readonly claim: string;
  readonly quote: string;
  readonly chunkIndex: number | null;
  readonly source: Source | undefined;
};

const sourceLabel = (source: Source) => {
  const title = source.title?.trim() || "Untitled";
  const date = source.publishedDate?.trim() ?? "";
  return date.length > 0 ? `${title} (${date})` : title;
};

const normalizeTags = (tags: readonly string[]) => [
  ...new Set(
    tags.map((tag) => tag.trim().toLowerCase().replaceAll(" ", "-")).filter((tag) => tag !== ""),
  ),
];

export const withFootnotes = (body: string, numbered: readonly Numbered[]) => {
  const byNumber = new Map(numbered.map((anchor) => [anchor.number, anchor]));
  const used: number[] = [];
  for (const match of body.matchAll(/\[\^(\d+)\]/g)) {
    const number = Number.parseInt(match[1] ?? "", 10);
    if (byNumber.has(number) && !used.includes(number)) used.push(number);
  }
  const display = new Map(used.map((number, index) => [number, index + 1]));
  const text = body
    .trim()
    .replace(/ ?\[\^(\d+)\]/g, (marker, raw: string) => {
      const shown = display.get(Number.parseInt(raw, 10));
      return shown === undefined ? "" : marker.replace(/\[\^\d+\]/, () => `[^${shown}]`);
    })
    .trimEnd();
  if (used.length === 0) return `${text}\n`;
  const notes = used.flatMap((number, index) => {
    const anchor = byNumber.get(number);
    if (anchor === undefined) return [];
    const link =
      anchor.source === undefined
        ? "unknown source"
        : `[${sourceLabel(anchor.source)}](${anchor.source.filePath}${
            anchor.chunkIndex === null ? "" : `#^p${anchor.chunkIndex}`
          })`;
    return [`[^${index + 1}]: ${link} — "${anchor.quote.trim()}"`];
  });
  return `${text}\n\n---\n\n${notes.join("\n")}\n`;
};

export const writeArticles = (
  dependencies: { readonly db: Database["Service"]; readonly runner: AskRunner },
  vaultId: Uuid,
  articles: readonly ArticleContent[],
  settings: WriterSettings,
) =>
  Effect.gen(function* () {
    const { db, runner } = dependencies;
    const ideaIds = [...new Set(articles.flatMap((article) => article.ideaIds))];
    const ideaRows =
      ideaIds.length === 0
        ? []
        : yield* db.query((d) =>
            d
              .select({
                ideaId: ideas.ideaId,
                documentId: ideas.documentId,
                kind: ideas.kind,
                label: ideas.label,
                description: ideas.description,
              })
              .from(ideas)
              .where(inUuidArray(ideas.ideaId, ideaIds)),
          );
    const anchorRows =
      ideaIds.length === 0
        ? []
        : yield* db.query((d) =>
            d
              .select({
                ideaId: anchors.ideaId,
                claim: anchors.claim,
                quote: anchors.quote,
                chunkIndex: anchors.chunkIndex,
              })
              .from(anchors)
              .where(inUuidArray(anchors.ideaId, ideaIds))
              .orderBy(asc(anchors.ideaId), asc(anchors.position)),
          );
    const sourceRows = yield* db.query((d) =>
      d
        .select({
          id: sourceDocuments.id,
          title: sourceDocuments.title,
          publishedDate: sourceDocuments.publishedDate,
          filePath: sourceDocuments.filePath,
        })
        .from(sourceDocuments)
        .where(eq(sourceDocuments.vaultId, vaultId)),
    );
    const ideaById = new Map(ideaRows.map((idea) => [idea.ideaId, idea]));
    const anchorsOf = new Map<Uuid, (typeof anchorRows)[number][]>();
    for (const anchor of anchorRows) append(anchorsOf, anchor.ideaId, anchor);
    const sourceById = new Map(sourceRows.map((source) => [source.id, source]));
    yield* runner.preloadKind("write_article");

    const prepare = (article: ArticleContent) => {
      const numbered: Numbered[] = [];
      const lines: string[] = [];
      for (const ideaId of article.ideaIds.toSorted()) {
        const idea = ideaById.get(ideaId);
        if (idea === undefined) continue;
        const source = sourceById.get(idea.documentId);
        lines.push(`### Idea: [${idea.kind}] ${idea.label}`);
        lines.push(`Description: ${idea.description}`);
        lines.push(`Source: ${source === undefined ? "unknown source" : sourceLabel(source)}`);
        for (const anchor of anchorsOf.get(ideaId) ?? []) {
          const number = numbered.length + 1;
          numbered.push({ number, ...anchor, source });
          lines.push(`[^${number}] claim: ${anchor.claim}`);
        }
        lines.push("");
      }
      const prompt = settings.prompt
        .replace("{title}", () => article.title)
        .replace("{description}", () => article.description)
        .replace("{idea_block}", () => lines.join("\n"));
      return { numbered, prompt };
    };

    let writtenCount = 0;
    yield* settings.progress("write_articles", 0, articles.length);
    const written = yield* Effect.forEach(
      articles,
      (article) => {
        const { numbered, prompt } = prepare(article);
        return runner
          .ask({
            kind: "write_article",
            model: settings.model,
            messages: [{ role: "user", content: prompt }],
            temperature: settings.temperature,
            reasoningEffort: settings.reasoningEffort,
            responseFormat: responseFormat("article", WrittenArticle),
            answer: WrittenArticle,
          })
          .pipe(
            Effect.map((answer): PublishedArticle | string => ({
              id: article.id,
              markdown: withFootnotes(answer.body, numbered),
              tags: normalizeTags(answer.tags),
            })),
            Effect.catchTag("AskFailed", () => Effect.succeed(article.title)),
            Effect.tap(() =>
              Effect.suspend(() => {
                writtenCount += 1;
                return settings.progress("write_articles", writtenCount, articles.length);
              }),
            ),
          );
      },
      { concurrency: settings.concurrency },
    );
    const published = written.flatMap((article) => (typeof article === "string" ? [] : [article]));
    const failedArticles = written.flatMap((article) =>
      typeof article === "string" ? [article] : [],
    );
    return { articles: published, failedArticles: failedArticles.toSorted() };
  });
