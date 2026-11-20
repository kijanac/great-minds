import { type Database, inUuidArray, topicMembership } from "@great-minds/database";
import type { Uuid } from "@great-minds/domain";
import { Effect, Schema } from "effect";

import { append } from "./collections.ts";
import { type AskRunner, orNoted } from "./compile-asks.ts";
import { responseFormat } from "./compile-themes.ts";
import type { ReasoningEffort } from "./config.ts";
import { noFailures, sortedFailures } from "./failure-ledger.ts";

const CANDIDATES = 3;

export const SuccessorPick = Schema.Struct({ choice: Schema.Int });

type Described = { readonly id: Uuid; readonly title: string; readonly description: string };

export type SuccessorSettings = {
  readonly model: string;
  readonly prompt: string;
  readonly temperature: number | undefined;
  readonly reasoningEffort: ReasoningEffort | undefined;
  readonly concurrency: number;
};

export const pickSuccessors = (
  dependencies: { readonly db: Database["Service"]; readonly runner: AskRunner },
  retired: readonly Described[],
  current: readonly (Described & { readonly ideaIds: readonly Uuid[] })[],
  settings: SuccessorSettings,
) =>
  Effect.gen(function* () {
    const { db, runner } = dependencies;
    const failedQuestions = noFailures();
    if (retired.length === 0) return { successorOf: new Map<Uuid, Uuid>(), failedQuestions };
    const memberships = yield* db.query((d) =>
      d
        .select({ topicId: topicMembership.topicId, ideaId: topicMembership.ideaId })
        .from(topicMembership)
        .where(
          inUuidArray(
            topicMembership.topicId,
            retired.map((topic) => topic.id),
          ),
        ),
    );
    const ideasOf = new Map<Uuid, Uuid[]>();
    for (const row of memberships) append(ideasOf, row.topicId, row.ideaId);
    const articlesOfIdea = new Map<Uuid, Uuid[]>();
    for (const article of current)
      for (const ideaId of article.ideaIds) append(articlesOfIdea, ideaId, article.id);
    const currentById = new Map(current.map((article) => [article.id, article]));
    yield* runner.preloadKind("pick_successor");
    const picked = yield* Effect.forEach(
      retired,
      (topic) =>
        Effect.gen(function* () {
          const ideas = ideasOf.get(topic.id) ?? [];
          const shared = new Map<Uuid, number>();
          for (const ideaId of ideas)
            for (const article of articlesOfIdea.get(ideaId) ?? [])
              shared.set(article, (shared.get(article) ?? 0) + 1);
          const shortlist = [...shared]
            .toSorted((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1))
            .slice(0, CANDIDATES);
          if (shortlist.length === 0) return [];
          const candidates = shortlist
            .map(([id, count], index) => {
              const article = currentById.get(id);
              return `${index + 1}. ${article?.title ?? ""} — ${article?.description ?? ""} (holds ${count} of the retired article's ${ideas.length} ideas)`;
            })
            .join("\n");
          const answer = yield* runner
            .ask({
              kind: "pick_successor",
              model: settings.model,
              messages: [
                {
                  role: "user",
                  content: settings.prompt
                    .replace(
                      "{retired}",
                      () => `Title: ${topic.title}\nDescription: ${topic.description}`,
                    )
                    .replace("{candidates}", () => candidates),
                },
              ],
              temperature: settings.temperature,
              reasoningEffort: settings.reasoningEffort,
              responseFormat: responseFormat("successor_pick", SuccessorPick),
              answer: SuccessorPick,
            })
            .pipe(orNoted(failedQuestions, `successor of "${topic.title}"`, { choice: 0 }));
          const successor = shortlist[answer.choice - 1]?.[0];
          return successor === undefined ? [] : [[topic.id, successor] as const];
        }),
      { concurrency: settings.concurrency },
    );
    return {
      successorOf: new Map(picked.flat()),
      failedQuestions: sortedFailures(failedQuestions),
    };
  });
