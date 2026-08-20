import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseFrontmatter, serializeFrontmatter } from "../src/markdown.ts";

type RenderedFile = { readonly path: string; readonly content: string };
type Golden = {
  readonly first: { readonly renderedFiles: readonly RenderedFile[] };
  readonly second: { readonly renderedFiles: readonly RenderedFile[] };
};

const goldenPath = fileURLToPath(new URL("../../goldens/goldens/compile.json", import.meta.url));

describe("markdown frontmatter", () => {
  it("round-trips every Python golden frontmatter block byte-exact", async () => {
    const golden = JSON.parse(await readFile(goldenPath, "utf8")) as Golden;
    let renderedFileCount = 0;
    let frontmatterFileCount = 0;

    for (const [snapshot, files] of [
      ["first", golden.first.renderedFiles],
      ["second", golden.second.renderedFiles],
    ] as const) {
      for (const file of files) {
        renderedFileCount += 1;
        const originalBlock = /^---\n.+?\n---\n/s.exec(file.content)?.[0];
        const parsed = parseFrontmatter(file.content);
        if (originalBlock === undefined) {
          expect(parsed, `${snapshot}/${file.path}`).toEqual({
            frontmatter: {},
            body: file.content,
          });
          continue;
        }

        frontmatterFileCount += 1;
        const roundTripped = serializeFrontmatter(parsed.frontmatter, parsed.body);
        expect(roundTripped, `${snapshot}/${file.path}`).toBe(file.content);
        expect(/^---\n.+?\n---\n/s.exec(roundTripped)?.[0], `${snapshot}/${file.path}`).toBe(
          originalBlock,
        );
      }
    }

    expect(renderedFileCount).toBe(57);
    expect(frontmatterFileCount).toBe(53);
  });
});
