import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { bodyContentHash, contentHash, fileContentHash, promptContentHash } from "../../server/src/crypto.ts";

const vectors = [
  [] as string[],
  [""],
  ["", ""],
  ["a", "bc"],
  ["ab", "c"],
  ["naïve", "東京", "🧠"],
  ["nul\u0000byte", "line\r\nending"],
  ["x".repeat(256)],
];

test("TypeScript hashes are byte-identical to Python native little-endian framing", () => {
  const script = `
import json,sys
from great_minds.core.hashing import content_hash,body_hash,file_hash,prompt_hash
vectors=json.loads(sys.stdin.read())
print(json.dumps({"content":[content_hash(*v) for v in vectors],"body":body_hash(""),"file":file_hash("東京"),"prompt":prompt_hash("naïve 🧠")}))
`;
  const python = spawnSync("uv", ["run", "python3", "-c", script], {
    cwd: new URL("../../..", import.meta.url),
    env: { ...process.env, UV_CACHE_DIR: process.env.UV_CACHE_DIR ?? "/tmp/gm-uv-cache" },
    input: JSON.stringify(vectors),
    encoding: "utf8",
  });
  assert.equal(python.status, 0, python.stderr);
  const expected = JSON.parse(python.stdout) as { content: string[]; body: string; file: string; prompt: string };
  assert.deepEqual(vectors.map((parts) => contentHash(...parts)), expected.content);
  assert.equal(bodyContentHash(""), expected.body);
  assert.equal(fileContentHash("東京"), expected.file);
  assert.equal(promptContentHash("naïve 🧠"), expected.prompt);
});
