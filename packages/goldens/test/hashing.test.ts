import assert from "node:assert/strict";
import test from "node:test";

import {
  bodyContentHash,
  contentHash,
  fileContentHash,
  promptContentHash,
} from "../../server/src/crypto.ts";

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

test("hash framing stays byte-exact", () => {
  const expected = {
    content: [
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "df3f619804a92fdb4057192dc43dd748ea778adc52bc498ce80524c014b81119",
      "af5570f5a1810b7af78caf4bc70a660f0df51e42baf91d4de5b2328de0e83dfc",
      "47ea6f805c5b663e33012cd34184e1398ad81a0dcea50071346f05d26692e843",
      "60014a36d7b05b0730e42a8b96faa1ffb4bd28469aea4000191179f01561ddb7",
      "92cc39c2b8f8efa00661a270e672818ff99ed306bf8477b2d745bfab3308e2ad",
      "f89c8ffd41084e3b16919be9b30791dee46e249a505ca250344f213a7ce2f0cc",
      "cb594f2b73c819692d6d45eed37d42c52b53cc3d2f103baf47dce82ad75295f1",
    ],
    body: "3882c66c818a2a362ab55c374939cb2e5ea744dc53e35444ce16bf324fcdde64",
    file: "8b749dd1cb5d3662adc14b7c529be176dc90429a03474910b70ded4e866d2f43",
    prompt: "d1a57dc33c587384725e57e184f87c0ae28f59aad1d266427461c2803b7eda1f",
  };
  assert.deepEqual(
    vectors.map((parts) => contentHash(...parts)),
    expected.content,
  );
  assert.equal(bodyContentHash(""), expected.body);
  assert.equal(fileContentHash("東京"), expected.file);
  assert.equal(promptContentHash("naïve 🧠"), expected.prompt);
});
