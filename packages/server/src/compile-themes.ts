import {
  anchors,
  type Database,
  ideas,
  inUuidArray,
  sourceDocuments,
  topicCandidates,
  topicProposals,
} from "@great-minds/database";
import { Uuid } from "@great-minds/domain";
import { and, asc, eq, sql } from "drizzle-orm";
import { Effect, Queue, Schema, Semaphore } from "effect";

import { append } from "./collections.ts";
import { askKey, type AskRunner, type Progress } from "./compile-asks.ts";
import { contentHash } from "./crypto.ts";
import type { EmbeddingsService } from "./embeddings.ts";

const SAME_TOPIC_SIMILARITY = 0.75;
const PAIRING_BATCH = 500;
const EMBEDDING_BATCH = 50;
const BLOCK_IDEAS = 6;
const BLOCK_CLAIMS = 2;

const IdeaTag = Schema.String.pipe(Schema.check(Schema.isPattern(/^idea_[0-9]+$/)));

export const ProposalAnswer = Schema.Struct({
  topics: Schema.Array(
    Schema.Struct({
      slug: Schema.String,
      title: Schema.String,
      description: Schema.String,
      inclusionTest: Schema.String,
      ideaTags: Schema.Array(IdeaTag),
    }).pipe(Schema.encodeKeys({ inclusionTest: "inclusion_test", ideaTags: "subsumed_idea_ids" })),
  ),
  setAside: Schema.Array(
    Schema.Struct({
      ideaTag: IdeaTag,
      reason: Schema.Literals(["bookkeeping", "passing mention", "not thematic"] as const),
    }).pipe(Schema.encodeKeys({ ideaTag: "idea_id" })),
  ),
}).pipe(Schema.encodeKeys({ setAside: "set_aside" }));

export const SameTopicAnswer = Schema.Struct({
  relation: Schema.Literals(["same", "related", "unrelated"] as const),
  reason: Schema.String,
});

export const responseFormat = (name: string, answer: Schema.Top) => ({
  type: "json_schema",
  json_schema: {
    name,
    strict: true,
    schema: Schema.toJsonSchemaDocument(Schema.toEncoded(answer)).schema,
  },
});

const FaceRows = Schema.Struct({
  rows: Schema.Array(Schema.Struct({ leader: Uuid, face: Uuid })),
});

export type ThemeSettings = {
  readonly model: string;
  readonly proposePrompt: string;
  readonly judgePrompt: string;
  readonly concurrency: number;
  readonly pivotsInFlight: number;
  readonly progress: Progress;
};

export type Theme = {
  readonly id: Uuid;
  readonly face: Uuid;
  readonly title: string;
  readonly description: string;
  readonly members: readonly Uuid[];
  readonly documentIds: readonly Uuid[];
  readonly ideaIds: readonly Uuid[];
};

type Dependencies = {
  readonly db: Database["Service"];
  readonly embeddings: EmbeddingsService["Service"];
  readonly runner: AskRunner;
};

export const pivotGroups = <K extends string, E, R>(
  order: readonly K[],
  neighbours: ReadonlyMap<K, readonly K[]>,
  judge: (pivot: K, open: readonly K[]) => Effect.Effect<readonly K[], E, R>,
  pivotsInFlight: number,
  onSettled: (settled: number) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const state = new Map<K, "open" | "active" | "absorbed" | "done">(
      order.map((id) => [id, "open"]),
    );
    const leader = new Map<K, K>();
    const askedOf = new Map<K, readonly K[]>();
    const active = new Set<K>();
    const finished = yield* Queue.unbounded<{ readonly id: K; readonly same: readonly K[] }, E>();
    let first = 0;
    let settledCount = 0;
    const openOf = (id: K) =>
      (neighbours.get(id) ?? []).filter((other) => state.get(other) === "open");
    const settled = (id: K | undefined) =>
      id !== undefined && (state.get(id) === "done" || state.get(id) === "absorbed");
    const startReady = Effect.gen(function* () {
      while (first < order.length && settled(order[first])) first += 1;
      const reach = new Set<K>();
      const claims = new Set<K>();
      let waiting = 0;
      for (
        let position = first;
        position < order.length && active.size < pivotsInFlight && waiting < pivotsInFlight;
        position += 1
      ) {
        const id = order[position];
        if (id === undefined || settled(id)) continue;
        if (state.get(id) !== "active") waiting += 1;
        if (state.get(id) === "active") {
          for (const other of neighbours.get(id) ?? []) reach.add(other);
          for (const other of askedOf.get(id) ?? []) claims.add(other);
          continue;
        }
        const open = openOf(id);
        const blocked = reach.has(id) || open.some((other) => claims.has(other));
        for (const other of neighbours.get(id) ?? []) reach.add(other);
        for (const other of open) claims.add(other);
        if (blocked) continue;
        state.set(id, "active");
        askedOf.set(id, open);
        active.add(id);
        yield* judge(id, open).pipe(
          Effect.matchEffect({
            onFailure: (error) => Queue.fail(finished, error),
            onSuccess: (same) => Queue.offer(finished, { id, same }),
          }),
          Effect.forkChild,
        );
      }
    });
    yield* startReady;
    while (active.size > 0) {
      const { id, same } = yield* Queue.take(finished);
      active.delete(id);
      const joined = new Set(same);
      for (const other of askedOf.get(id) ?? []) {
        if (!joined.has(other)) continue;
        state.set(other, "absorbed");
        leader.set(other, id);
        settledCount += 1;
      }
      state.set(id, "done");
      leader.set(id, id);
      settledCount += 1;
      yield* onSettled(settledCount);
      yield* startReady;
      yield* Effect.yieldNow;
    }
    for (const id of order) if (!leader.has(id)) leader.set(id, id);
    return leader;
  });

export const loadLibrary = (db: Database["Service"], vaultId: Uuid) =>
  Effect.gen(function* () {
    const documents = yield* db.query((d) =>
      d
        .select({
          id: sourceDocuments.id,
          title: sourceDocuments.title,
          genre: sourceDocuments.genre,
          precis: sourceDocuments.precis,
          tags: sourceDocuments.tags,
        })
        .from(sourceDocuments)
        .where(eq(sourceDocuments.vaultId, vaultId))
        .orderBy(asc(sourceDocuments.id)),
    );
    const ideaRows = yield* db.query((d) =>
      d
        .select({
          ideaId: ideas.ideaId,
          documentId: ideas.documentId,
          kind: ideas.kind,
          label: ideas.label,
          description: ideas.description,
        })
        .from(ideas)
        .where(eq(ideas.vaultId, vaultId))
        .orderBy(asc(ideas.ideaId)),
    );
    const claimRows = yield* db.query((d) =>
      d
        .select({ ideaId: anchors.ideaId, claim: anchors.claim })
        .from(anchors)
        .innerJoin(ideas, eq(ideas.ideaId, anchors.ideaId))
        .where(eq(ideas.vaultId, vaultId))
        .orderBy(asc(anchors.ideaId), asc(anchors.position)),
    );
    const claimsOf = new Map<string, string[]>();
    for (const row of claimRows) append(claimsOf, row.ideaId, row.claim);
    const ideasOf = new Map<string, (typeof ideaRows)[number][]>();
    for (const row of ideaRows) append(ideasOf, row.documentId, row);
    return {
      documents,
      ideasOf,
      ideaById: new Map(ideaRows.map((row) => [row.ideaId, row])),
      claimsOf,
    };
  });

const proposalRequest = (
  settings: ThemeSettings,
  document: {
    readonly title: string | null;
    readonly genre: string | null;
    readonly precis: string | null;
    readonly tags: readonly string[];
  },
  documentIdeas: readonly {
    readonly ideaId: Uuid;
    readonly kind: string;
    readonly label: string;
    readonly description: string;
  }[],
  claimsOf: ReadonlyMap<string, readonly string[]>,
) => {
  const lines = [`## Doc: ${document.title ?? ""}`];
  if (document.genre) lines.push(`Genre: ${document.genre}`);
  if (document.precis) lines.push(`Precis: ${document.precis}`);
  if (document.tags.length > 0) lines.push(`Tags: ${document.tags.join(", ")}`);
  lines.push("Ideas:");
  const tags = new Map<string, Uuid>();
  documentIdeas.forEach((idea, index) => {
    const tag = `idea_${index + 1}`;
    tags.set(tag, idea.ideaId);
    lines.push(`- ${tag} [${idea.kind}] ${idea.label}: ${idea.description}`);
    for (const claim of claimsOf.get(idea.ideaId) ?? []) lines.push(`  - claim: ${claim}`);
  });
  return {
    tags,
    request: {
      kind: "propose_topics",
      model: settings.model,
      messages: [
        {
          role: "user" as const,
          content: settings.proposePrompt.replace("{idea_block}", () => lines.join("\n")),
        },
      ],
      temperature: 0,
      responseFormat: responseFormat("document_topics", ProposalAnswer),
      answer: ProposalAnswer,
    },
  };
};

export type Library = Effect.Success<ReturnType<typeof loadLibrary>>;

export const proposeTopics = (
  dependencies: Dependencies,
  vaultId: Uuid,
  library: Library,
  settings: ThemeSettings,
) =>
  Effect.gen(function* () {
    const { db, embeddings, runner } = dependencies;
    const { documents, ideasOf, claimsOf } = library;
    yield* runner.preloadKind("propose_topics");
    const asking = documents.filter((document) => (ideasOf.get(document.id) ?? []).length > 0);
    let answeredCount = 0;
    const tick = Effect.suspend(() => {
      answeredCount += 1;
      return settings.progress("propose_topics", answeredCount, asking.length);
    });
    yield* settings.progress("propose_topics", 0, asking.length);
    const asked = yield* Effect.forEach(
      asking,
      (document) => {
        const { tags, request } = proposalRequest(
          settings,
          document,
          ideasOf.get(document.id) ?? [],
          claimsOf,
        );
        const key = askKey(request);
        return runner.ask(request).pipe(
          Effect.map((answer) => ({
            documentId: document.id,
            key,
            topics: answer.topics.flatMap((topic) => {
              const ideaIds = [...new Set(topic.ideaTags.flatMap((tag) => tags.get(tag) ?? []))];
              return ideaIds.length === 0 ? [] : [{ ...topic, ideaIds }];
            }),
          })),
          Effect.catchTag("AskFailed", () =>
            Effect.succeed({ documentId: document.id, failed: true as const }),
          ),
          Effect.tap(() => tick),
        );
      },
      { concurrency: settings.concurrency },
    );
    const answered = asked.flatMap((answer) => ("failed" in answer ? [] : [answer]));
    const failedDocuments = asked.flatMap((answer) =>
      "failed" in answer ? [answer.documentId] : [],
    );
    const keys = answered.map((answer) => answer.key);
    yield* db.query((d) =>
      d
        .delete(topicProposals)
        .where(
          and(
            eq(topicProposals.vaultId, vaultId),
            sql`${topicProposals.askKey} not in (select unnest(${sql.param(keys)}::text[]))`,
            sql`${topicProposals.documentId} not in (select unnest(${sql.param(failedDocuments)}::uuid[]))`,
          ),
        ),
    );
    const stored = new Set(
      (yield* db.query((d) =>
        d
          .selectDistinct({ askKey: topicProposals.askKey })
          .from(topicProposals)
          .where(eq(topicProposals.vaultId, vaultId)),
      )).map((row) => row.askKey),
    );
    const fresh = answered
      .filter((answer) => !stored.has(answer.key))
      .flatMap((answer) =>
        answer.topics.map((topic, position) => ({
          documentId: answer.documentId,
          askKey: answer.key,
          position,
          topic,
        })),
      );
    for (let offset = 0; offset < fresh.length; offset += EMBEDDING_BATCH) {
      const batch = fresh.slice(offset, offset + EMBEDDING_BATCH);
      const vectors = yield* embeddings.embed(
        batch.map(({ topic }) => `${topic.title.trim()}. ${topic.description.trim()}`),
      );
      yield* db.query((d) =>
        d
          .insert(topicProposals)
          .values(
            batch.map(({ documentId, askKey, position, topic }, index) => ({
              vaultId,
              documentId,
              askKey,
              position,
              title: topic.title.trim(),
              description: topic.description.trim(),
              inclusionTest: topic.inclusionTest.trim(),
              ideaIds: [...topic.ideaIds],
              embedding: [...(vectors[index] ?? [])],
            })),
          )
          .onConflictDoNothing(),
      );
    }
    return {
      documents: answered.length,
      failedDocuments: failedDocuments.length,
      newTopics: fresh.length,
    };
  });

export const pairCandidates = (db: Database["Service"], vaultId: Uuid) =>
  Effect.gen(function* () {
    const unpaired = (yield* db.query((d) =>
      d
        .select({ id: topicProposals.id })
        .from(topicProposals)
        .where(and(eq(topicProposals.vaultId, vaultId), eq(topicProposals.paired, false)))
        .orderBy(asc(topicProposals.id)),
    )).map((row) => row.id);
    for (let offset = 0; offset < unpaired.length; offset += PAIRING_BATCH) {
      const batch = unpaired.slice(offset, offset + PAIRING_BATCH);
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.execute(sql`
            insert into ${topicCandidates} (vault_id, lower_id, higher_id, similarity)
            select ${vaultId}::uuid, least(n.id, o.id), greatest(n.id, o.id), 1 - (n.embedding <=> o.embedding)
            from ${topicProposals} n
            join ${topicProposals} o
              on o.vault_id = n.vault_id
             and o.document_id <> n.document_id
             and (o.paired or o.id > n.id)
            where n.id = any(${sql.param(batch)}::uuid[])
              and (n.embedding <=> o.embedding) <= ${1 - SAME_TOPIC_SIMILARITY}
            on conflict do nothing`);
          yield* tx
            .update(topicProposals)
            .set({ paired: true })
            .where(inUuidArray(topicProposals.id, batch));
        }),
      );
      yield* Effect.yieldNow;
    }
    return { paired: unpaired.length };
  });

export const loadBlocks = (db: Database["Service"], vaultId: Uuid, library: Library) =>
  Effect.gen(function* () {
    const { documents, ideaById, claimsOf } = library;
    const documentById = new Map(documents.map((document) => [document.id, document]));
    const proposals = yield* db.query((d) =>
      d
        .select({
          id: topicProposals.id,
          documentId: topicProposals.documentId,
          askKey: topicProposals.askKey,
          position: topicProposals.position,
          title: topicProposals.title,
          description: topicProposals.description,
          inclusionTest: topicProposals.inclusionTest,
          ideaIds: topicProposals.ideaIds,
        })
        .from(topicProposals)
        .where(eq(topicProposals.vaultId, vaultId)),
    );
    const blocks = new Map(
      proposals.map((proposal) => {
        const document = documentById.get(proposal.documentId);
        const lines = [
          `Title: ${proposal.title}`,
          `Description: ${proposal.description}`,
          `Inclusion test: ${proposal.inclusionTest}`,
          `Proposed from the document: "${document?.title ?? ""}" (${document?.genre ?? "unknown genre"})`,
          "Ideas placed under it, with the document's claims:",
        ];
        for (const ideaId of proposal.ideaIds.slice(0, BLOCK_IDEAS)) {
          const idea = ideaById.get(ideaId);
          if (idea === undefined) continue;
          lines.push(`- [${idea.kind}] ${idea.label}: ${idea.description}`);
          for (const claim of (claimsOf.get(ideaId) ?? []).slice(0, BLOCK_CLAIMS))
            lines.push(`  - claim: ${claim}`);
        }
        return [proposal.id, lines.join("\n")] as const;
      }),
    );
    return { proposals, blocks, ideaById, claimsOf };
  });

export type Blocks = Effect.Success<ReturnType<typeof loadBlocks>>;

export const groupThemes = (
  dependencies: Dependencies,
  vaultId: Uuid,
  loaded: Blocks,
  settings: ThemeSettings,
) =>
  Effect.gen(function* () {
    const { db, runner } = dependencies;
    const { proposals, blocks } = loaded;
    const candidates = yield* db.query((d) =>
      d
        .select({
          lowerId: topicCandidates.lowerId,
          higherId: topicCandidates.higherId,
          similarity: topicCandidates.similarity,
        })
        .from(topicCandidates)
        .where(eq(topicCandidates.vaultId, vaultId)),
    );
    const scored = new Map<Uuid, [Uuid, number][]>();
    for (const { lowerId, higherId, similarity } of candidates) {
      append(scored, lowerId, [higherId, similarity]);
      append(scored, higherId, [lowerId, similarity]);
    }
    const orderKey = new Map(
      proposals.map((proposal) => [
        proposal.id,
        contentHash(proposal.askKey, String(proposal.position)),
      ]),
    );
    const byOrder = (left: Uuid, right: Uuid) =>
      (orderKey.get(left) ?? "") < (orderKey.get(right) ?? "") ? -1 : 1;
    const neighbours = new Map(
      [...scored].map(([id, list]) => [
        id,
        list
          .sort((left, right) => right[1] - left[1] || byOrder(left[0], right[0]))
          .map(([other]) => other),
      ]),
    );
    const permits = yield* Semaphore.make(settings.concurrency);
    let failedJudgments = 0;
    yield* runner.preloadKind("same_topic");
    const judge = (pivot: Uuid, open: readonly Uuid[]) =>
      Effect.forEach(
        open,
        (candidate) =>
          runner
            .ask({
              kind: "same_topic",
              model: settings.model,
              messages: [
                {
                  role: "user",
                  content: settings.judgePrompt
                    .replace("{topic_a}", () => blocks.get(pivot) ?? "")
                    .replace("{topic_b}", () => blocks.get(candidate) ?? ""),
                },
              ],
              temperature: 0,
              responseFormat: responseFormat("topic_relation", SameTopicAnswer),
              answer: SameTopicAnswer,
            })
            .pipe(
              Semaphore.withPermit(permits),
              Effect.map((answer): readonly Uuid[] =>
                answer.relation === "same" ? [candidate] : [],
              ),
              Effect.catchTag("AskFailed", () =>
                Effect.sync((): readonly Uuid[] => {
                  failedJudgments += 1;
                  return [];
                }),
              ),
            ),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((joined) => joined.flat()));
    const order = proposals.map((proposal) => proposal.id).toSorted(byOrder);
    yield* settings.progress("group_topics", 0, order.length);
    const leader = yield* pivotGroups(order, neighbours, judge, settings.pivotsInFlight, (settled) =>
      settings.progress("group_topics", settled, order.length),
    );
    const leaders = order.map((id) => leader.get(id) ?? id);
    const faceResult = yield* db.query((d) =>
      d.execute(sql`
        with g as (select * from unnest(${sql.param(order)}::uuid[], ${sql.param(leaders)}::uuid[]) as g(id, leader)),
        c as (select g.leader, avg(p.embedding) as centroid from g join ${topicProposals} p on p.id = g.id group by g.leader)
        select distinct on (g.leader) g.leader as leader, g.id as face
        from g join ${topicProposals} p on p.id = g.id join c on c.leader = g.leader
        order by g.leader, p.embedding <=> c.centroid, g.id`),
    );
    const faces = yield* Schema.decodeUnknownEffect(FaceRows)(faceResult).pipe(Effect.orDie);
    const proposalById = new Map(proposals.map((proposal) => [proposal.id, proposal]));
    const membersOf = new Map<Uuid, Uuid[]>();
    order.forEach((id, index) => {
      const group = leaders[index] ?? id;
      append(membersOf, group, id);
    });
    const faceOf = new Map(faces.rows.map((row) => [row.leader, row.face]));
    const themes = [...membersOf].map(([group, members]): Theme => {
      const face = faceOf.get(group) ?? group;
      const shown = proposalById.get(face);
      const memberRows = members.flatMap((member) => proposalById.get(member) ?? []);
      return {
        id: group,
        face,
        title: shown?.title ?? "",
        description: shown?.description ?? "",
        members,
        documentIds: [...new Set(memberRows.map((row) => row.documentId))],
        ideaIds: [...new Set(memberRows.flatMap((row) => row.ideaIds))],
      };
    });
    return { themes, failedJudgments };
  });
