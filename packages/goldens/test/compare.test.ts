import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

import { contentHash, fileContentHash } from "../../server/src/crypto.ts";
import { compareSnapshots, type Json } from "../src/compare.ts";

const goldenIdea = "01900000-0000-7000-8000-000000000001";
const replayIdea = "01900000-0000-7000-8000-000000000002";
const goldenTopic = "01900000-0000-7000-8000-000000000003";
const replayTopic = "01900000-0000-7000-8000-000000000004";
const goldenArticle = "10000000-0000-4000-8000-000000000005";
const replayArticle = "10000000-0000-4000-8000-000000000006";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

const fixture = (ideaId: string, topicId: string, articleId: string): Record<string, Json> => {
  const compiled = contentHash("Topic", "Description", ideaId);
  const content = `---\ntopic_id: ${topicId}\n---\n# Topic\n`;
  return {
    schemaVersion: 2,
    hashContract: {},
    compileCache: [{ sort_key: "partition", phase: "partition", cache_key: contentHash(ideaId, "target=400"), value: { chunks: [[ideaId]] } }],
    sources: [],
    ideas: [{ sort_key: "idea", idea_id: ideaId, document_id: "10000000-0000-4000-8000-000000000010", kind: "claim", label: "Label", description: "Description", anchors: [{ position: 0, claim: "Claim", quote: "Quote", chunk_index: 0 }], embedding_hash: "same" }],
    partitionAssignments: [],
    topics: [{ sort_key: "topic", topic_id: topicId, slug: "topic", title: "Topic", description: "Description", article_status: "rendered", compiled_from_hash: compiled, rendered_from_hash: compiled, supersedes: null, superseded_by: null }],
    memberships: [{ sort_key: "membership", topic_id: topicId, idea_id: ideaId }],
    articles: [{ sort_key: "wiki/topic.md", id: articleId, topic_id: topicId, file_path: "wiki/topic.md", file_hash: fileContentHash(content), body_hash: "same-body", title: "Topic", precis: "Description", archived: false, tags: [] }],
    backlinks: [{ sort_key: "self", source_article_id: articleId, target_article_id: articleId }],
    searchIndex: [],
    renderedTree: [{ path: "wiki/topic.md", sha256: sha(content) }],
    renderedFiles: [{ path: "wiki/topic.md", content }],
    progressSequences: [],
    envelope: { registrySize: 1, membershipsPerTopic: [1], articlesProduced: 1 },
  };
};

test("UUID alpha-equivalence rewrites identities and every derived hash before exact comparison", () => {
  const golden = fixture(goldenIdea, goldenTopic, goldenArticle);
  const replay = fixture(replayIdea, replayTopic, replayArticle);
  assert.equal(compareSnapshots(golden, replay).diff, undefined);
});

test("duplicate identity-free keys fail instead of collapsing into a many-to-one mapping", () => {
  const golden = fixture(goldenIdea, goldenTopic, goldenArticle);
  const replay = fixture(replayIdea, replayTopic, replayArticle);
  (replay.ideas as Json[]).push(structuredClone((replay.ideas as Json[])[0]!));
  assert.throws(() => compareSnapshots(golden, replay), /stable key is not unique/);
});

test("UUID alpha-equivalence is reflexive, symmetric, and transitive", () => {
  const thirdIdea = "01900000-0000-7000-8000-000000000012";
  const thirdTopic = "01900000-0000-7000-8000-000000000014";
  const thirdArticle = "10000000-0000-4000-8000-000000000016";
  const first = fixture(goldenIdea, goldenTopic, goldenArticle);
  const second = fixture(replayIdea, replayTopic, replayArticle);
  const third = fixture(thirdIdea, thirdTopic, thirdArticle);
  assert.equal(compareSnapshots(first, first).diff, undefined);
  assert.equal(compareSnapshots(first, second).diff, undefined);
  assert.equal(compareSnapshots(second, first).diff, undefined);
  assert.equal(compareSnapshots(second, third).diff, undefined);
  assert.equal(compareSnapshots(first, third).diff, undefined);
});
