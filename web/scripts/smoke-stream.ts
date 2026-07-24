import assert from "node:assert/strict";

import { createServer } from "vite";

interface SmokeHastNode {
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: SmokeHastNode[];
}

function someHastNode(
  node: SmokeHastNode,
  predicate: (candidate: SmokeHastNode) => boolean,
): boolean {
  return predicate(node) || (node.children ?? []).some((child) => someHastNode(child, predicate));
}

const events = [
  ["token", { text: "Plan → " }],
  [
    "source_pending",
    {
      call_id: "kb-search",
      source: {
        type: "search",
        query: "vector search",
        scope: "kb",
        title: "Knowledge base",
      },
    },
  ],
  ["token", { text: "kb thought" }],
  ["source_settled", { call_id: "kb-search" }],
  [
    "source",
    {
      type: "search",
      query: "vector search",
      scope: "kb",
      title: "Knowledge base",
    },
  ],
  ["token", { text: "web thought" }],
  [
    "source",
    {
      type: "search",
      query: "vector databases",
      scope: "web",
      title: "Web results",
    },
  ],
  ["token", { text: "doc thought" }],
  [
    "source_pending",
    {
      call_id: "doc-search",
      source: {
        type: "search",
        query: "index layout",
        scope: "kb",
        path: "/docs/guide.md",
        title: "Guide search",
      },
    },
  ],
  ["source_settled", { call_id: "doc-search" }],
  [
    "source",
    {
      type: "search",
      query: "index layout",
      scope: "kb",
      path: "/docs/guide.md",
      title: "Guide search",
    },
  ],
  ["token", { text: "article thought" }],
  [
    "source_pending",
    {
      call_id: "article-read",
      source: {
        type: "article",
        path: "/docs/guide.md",
        title: "Guide",
      },
    },
  ],
  ["source_settled", { call_id: "article-read" }],
  [
    "source",
    {
      type: "article",
      path: "/docs/guide.md",
      title: "Guide",
    },
  ],
  ["token", { text: "expand thought" }],
  [
    "source_pending",
    {
      call_id: "article-expand",
      source: {
        type: "article",
        path: "/docs/guide.md",
        title: "Guide",
        start: 4,
        end: 9,
      },
    },
  ],
  ["source_settled", { call_id: "article-expand" }],
  [
    "source",
    {
      type: "article",
      path: "/docs/guide.md",
      title: "Guide",
      start: 4,
      end: 9,
    },
  ],
  ["token", { text: "links thought" }],
  [
    "source_pending",
    {
      call_id: "links-first",
      source: {
        type: "links",
        path: "/docs/guide.md",
        title: "Guide links",
      },
    },
  ],
  ["source_settled", { call_id: "links-first" }],
  [
    "source",
    {
      type: "links",
      path: "/docs/guide.md",
      title: "Guide links",
    },
  ],
  ["token", { text: "duplicate links" }],
  [
    "source_pending",
    {
      call_id: "links-duplicate",
      source: {
        type: "links",
        path: "/docs/guide.md",
        title: "Guide links",
      },
    },
  ],
  ["source_settled", { call_id: "links-duplicate" }],
  [
    "source",
    {
      type: "links",
      path: "/docs/guide.md",
      title: "Guide links",
    },
  ],
  [
    "source_pending",
    {
      call_id: "filtered-query",
      source: {
        type: "query",
        filters: { kind: "essay", year: 2026 },
      },
    },
  ],
  ["token", { text: "filter thought" }],
  ["source_settled", { call_id: "filtered-query" }],
  ["source", { type: "query", filters: { kind: "essay", year: 2026 } }],
  ["token", { text: "tool miss thought" }],
  [
    "source_pending",
    {
      call_id: "tool-miss",
      source: {
        type: "search",
        query: "missing source",
        scope: "web",
        title: "Never resolved",
      },
    },
  ],
  ["source_settled", { call_id: "tool-miss" }],
  ["token", { text: "Final answer." }],
  ["done", {}],
] as const;

const expectedSnapshot = {
  reply_id: "00000000-0000-4000-8000-000000000001",
  session_id: null,
  kind: "ephemeral",
  status: "completed",
  answer: "Final answer.",
  sources: [
    {
      label: "vector search",
      type: "search",
      scope: "kb",
      title: "Knowledge base",
      thinking: "kb thought",
    },
  ],
  error: null,
  version: 2,
  created_at: "2026-07-23T12:00:00.000Z",
  updated_at: "2026-07-23T12:00:01.000Z",
} as const;
const sse =
  `event: connected\ndata: {"id":"${expectedSnapshot.reply_id}"}\n\n` +
  `data: ${JSON.stringify(expectedSnapshot)}\n\n` +
  `event: done\ndata: {"id":"${expectedSnapshot.reply_id}"}\n\n`;
const encoded = new TextEncoder().encode(sse);
const widths = [1, 3, 11, 2, 17, 5, 23];

const body = new ReadableStream<Uint8Array>({
  start(controller) {
    let offset = 0;
    let widthIndex = 0;
    while (offset < encoded.length) {
      const next = Math.min(offset + widths[widthIndex % widths.length], encoded.length);
      controller.enqueue(encoded.slice(offset, next));
      offset = next;
      widthIndex += 1;
    }
    controller.close();
  },
});

const expected = {
  answer: "Final answer.",
  sources: [
    {
      label: "vector search",
      type: "search",
      scope: "kb",
      path: undefined,
      title: "Knowledge base",
      thinking: "kb thought",
      pending: undefined,
    },
    {
      label: "vector databases",
      type: "search",
      scope: "web",
      path: undefined,
      title: "Web results",
      thinking: "web thought",
      pending: undefined,
    },
    {
      label: "index layout",
      type: "search",
      scope: "kb",
      path: "/docs/guide.md",
      title: "Guide search",
      thinking: "doc thought",
      pending: undefined,
    },
    {
      label: "/docs/guide.md",
      type: "article",
      title: "Guide",
      thinking: "article thought",
      ranges: [{ start: 4, end: 9 }],
      full: true,
      pending: undefined,
    },
    {
      label: "/docs/guide.md",
      type: "links",
      title: "Guide links",
      thinking: "links thought",
      pending: undefined,
    },
    {
      label: "kind: essay, year: 2026",
      type: "query",
      thinking: "filter thought",
      pending: undefined,
    },
  ],
};

const originalFetch = globalThis.fetch;
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const server = await createServer({
  appType: "custom",
  logLevel: "silent",
  server: { middlewareMode: true },
});

try {
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { origin: "http://smoke.test" },
  });
  const storedValues = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem(key: string) {
        return storedValues.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        storedValues.set(key, value);
      },
      removeItem(key: string) {
        storedValues.delete(key);
      },
    },
  });

  globalThis.fetch = async (input, init) => {
    if (init?.method === "POST") {
      assert.equal(String(input), "http://smoke.test/api/vaults/smoke-vault/replies");
      assert.deepEqual(JSON.parse(String(init.body)), {
        kind: "ephemeral",
        question: "smoke",
        history: [],
        mode: "query",
      });
      return Response.json(
        { reply_id: expectedSnapshot.reply_id, session_id: null },
        { status: 202 },
      );
    }
    assert.equal(
      String(input),
      `http://smoke.test/api/vaults/smoke-vault/replies/${expectedSnapshot.reply_id}/stream`,
    );
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  localStorage.setItem("vault_id", "smoke-vault");

  const markdownModule = (await server.ssrLoadModule("/src/lib/markdown.ts")) as {
    parseMarkdown: (source: string) => SmokeHastNode;
  };
  const footnoteModule = (await server.ssrLoadModule("/src/lib/footnote-notes.ts")) as {
    buildFootnotePresentation: (
      roots: readonly SmokeHastNode[],
      idPrefix: string,
    ) => { notes: { content: SmokeHastNode }[] };
  };
  const unresolvedTree = markdownModule.parseMarkdown(
    "A streaming reference[^later] without its definition yet.",
  );
  const unresolvedFootnotes = footnoteModule.buildFootnotePresentation(
    [unresolvedTree],
    "stream-smoke",
  );
  assert.equal(unresolvedFootnotes.notes.length, 0);

  const resolvedTree = markdownModule.parseMarkdown(
    "A resolved reference[^ready].\n\n[^ready]: A [live link](/docs/guide.md).",
  );
  const resolvedFootnotes = footnoteModule.buildFootnotePresentation(
    [resolvedTree],
    "stream-smoke",
  );
  assert.equal(resolvedFootnotes.notes.length, 1);
  assert.equal(
    someHastNode(
      resolvedFootnotes.notes[0].content,
      (node) => node.properties?.dataFootnoteBackref != null,
    ),
    false,
  );
  assert.equal(
    someHastNode(
      resolvedFootnotes.notes[0].content,
      (node) => node.properties?.href === "/docs/guide.md",
    ),
    true,
  );

  const repliesModule = (await server.ssrLoadModule("/src/lib/api/replies.ts")) as {
    createReply: (payload: Record<string, unknown>) => Promise<{ reply_id: string }>;
    streamReply: (replyId: string) => AsyncGenerator<unknown>;
  };

  const created = await repliesModule.createReply({
    kind: "ephemeral",
    question: "smoke",
    history: [],
    mode: "query",
  });
  const snapshots = [];
  for await (const snapshot of repliesModule.streamReply(created.reply_id)) {
    snapshots.push(snapshot);
  }
  assert.deepStrictEqual(snapshots, [expectedSnapshot]);
  console.log("stream smoke passed");
} finally {
  globalThis.fetch = originalFetch;
  if (originalLocation) {
    Object.defineProperty(globalThis, "location", originalLocation);
  } else {
    Reflect.deleteProperty(globalThis, "location");
  }
  if (originalLocalStorage) {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
  } else {
    Reflect.deleteProperty(globalThis, "localStorage");
  }
  await server.close();
}
