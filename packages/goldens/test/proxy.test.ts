import assert from "node:assert/strict";
import test from "node:test";

import { assignmentRequestKey, cassetteAssignmentTable, createReplayOrderGate, renderRequestKey, requestBodyHash, rewriteAssignmentNumbers, rewriteAssignmentsFromTable, rewriteEmbeddingOrder } from "../src/proxy.ts";

test("cassette request keys erase UUID identity while artifact comparison owns bijection validation", () => {
  const first = Buffer.from(JSON.stringify({ ids: ["01900000-0000-7000-8000-000000000001", "01900000-0000-7000-8000-000000000002", "01900000-0000-7000-8000-000000000001"] }));
  const renamed = Buffer.from(JSON.stringify({ ids: ["01900000-0000-7000-8000-000000000010", "01900000-0000-7000-8000-000000000011", "01900000-0000-7000-8000-000000000010"] }));
  const collapsed = Buffer.from(JSON.stringify({ ids: ["01900000-0000-7000-8000-000000000010", "01900000-0000-7000-8000-000000000010", "01900000-0000-7000-8000-000000000010"] }));
  const derived = Buffer.from(JSON.stringify({ ids: ["01900000-0000-7000-8000-000000000010", "01900000-0000-7000-8000-000000000011", "01900000-0000-7000-8000-000000000010"], cache_key: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }));
  const renamedDerived = Buffer.from(JSON.stringify({ ids: ["01900000-0000-7000-8000-000000000001", "01900000-0000-7000-8000-000000000002", "01900000-0000-7000-8000-000000000001"], cache_key: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }));
  assert.equal(requestBodyHash(first), requestBodyHash(renamed));
  assert.equal(requestBodyHash(first), requestBodyHash(collapsed));
  assert.equal(requestBodyHash(derived), requestBodyHash(renamedDerived));
});

test("embedding replay follows provider indices when response rows are out of order", () => {
  const recorded = { input: ["alpha", "beta", "gamma"] };
  const replay = { input: ["gamma", "alpha", "beta"] };
  const response = {
    data: [
      { index: 2, embedding: [3] },
      { index: 0, embedding: [1] },
      { index: 1, embedding: [2] },
    ],
  };

  assert.deepEqual(rewriteEmbeddingOrder(recorded, replay, response), {
    data: [
      { index: 0, embedding: [3] },
      { index: 1, embedding: [1] },
      { index: 2, embedding: [2] },
    ],
  });
});

test("replay order gate releases concurrent responses in recorded completion order", async () => {
  const gate = createReplayOrderGate();
  const released: number[] = [];
  const respond = async (rank: number) => {
    await gate.wait(rank);
    released.push(rank);
    gate.release(rank);
  };

  await Promise.all([respond(2), respond(1), respond(0)]);
  assert.deepEqual(released, [0, 1, 2]);
});

test("render routing uses identity-free topic title and description", () => {
  const prompt = (id: string) => ({ messages: [{ role: "user", content: `cache ${id}\n## Topic\n\nTitle: Durable Institutions\nDescription: A stable description.\n\n## Ideas and anchors\n\n${id}` }] });
  assert.equal(renderRequestKey(prompt("01900000-0000-7000-8000-000000000001")), renderRequestKey(prompt("01900000-0000-7000-8000-000000000002")));
  assert.notEqual(renderRequestKey(prompt("01900000-0000-7000-8000-000000000001")), "");
});

test("assignment routing matches candidate content and rewrites positional numbers", () => {
  const request = (lines: string[]) => ({ messages: [{ content: `You are filing candidate sub-topics\nSUB-TOPICS:\n\n${lines.join("\n")}` }] });
  const recorded = request(["1. Alpha :: First", "2. Beta :: Second"]);
  const replay = request(["1. Beta :: Second", "2. Alpha :: First"]);
  const response = { choices: [{ message: { content: JSON.stringify({ assignments: [{ n: 1, slug: "alpha" }, { n: 2, slug: "beta" }] }) } }] };
  assert.equal(assignmentRequestKey(recorded), assignmentRequestKey(replay));
  const rewritten = rewriteAssignmentNumbers(recorded, replay, response) as typeof response;
  assert.deepEqual(JSON.parse(rewritten.choices[0]!.message.content), { assignments: [{ n: 2, slug: "alpha" }, { n: 1, slug: "beta" }] });
});

test("cassette-wide assignment table survives replay batch-boundary shifts", () => {
  const request = (lines: string[]) => ({ messages: [{ content: `SUB-TOPICS:\n\n${lines.join("\n")}` }] });
  const response = (assignments: { n: number; slug: string }[]) => ({ choices: [{ message: { content: JSON.stringify({ assignments }) } }] });
  const entries = [
    { requestBody: request(["1. Alpha :: First", "2. Beta :: Second"]), response: { body: response([{ n: 1, slug: "alpha" }, { n: 2, slug: "beta" }]) } },
    { requestBody: request(["1. Gamma :: Third"]), response: { body: response([{ n: 1, slug: "gamma" }]) } },
  ] as never;
  const replay = request(["1. Gamma :: Third", "2. Alpha :: First"]);
  const rewritten = rewriteAssignmentsFromTable(cassetteAssignmentTable(entries), replay, response([])) as ReturnType<typeof response>;
  assert.deepEqual(JSON.parse(rewritten.choices[0]!.message.content), { assignments: [{ n: 1, slug: "gamma" }, { n: 2, slug: "alpha" }] });
});
