import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  footnoteDefinitions,
  footnoteNotes,
  markdownParagraphs,
  openingSentence,
  parseFrontmatter,
  serializeFrontmatter,
  withoutFootnoteDefinitions,
} from "../src/markdown.ts";

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

const article = [
  "# Revolt",
  "",
  "The strikes of 1896 in St. Petersburg drew 30,000 workers[^1]. Later ones grew[^2].",
  "",
  "## The rear",
  "",
  "Banditry spread behind the lines[^2][^3].",
  "",
  "---",
  "",
  '[^1]: [Source A (1896)](raw/docs/a.md#^p3) — "quote one"',
  '[^2]: [Source B](raw/docs/b.md) — "quote two"',
  '[^3]: [Source C](raw/docs/c.md#^p9) — "quote three"',
  "",
].join("\n");

describe("article footnotes and openings", () => {
  it("indexes an article's paragraphs without its footnote list", () => {
    expect(markdownParagraphs(withoutFootnoteDefinitions(article)).map((p) => p.body)).toEqual([
      "The strikes of 1896 in St. Petersburg drew 30,000 workers[^1]. Later ones grew[^2].",
      "Banditry spread behind the lines[^2][^3].",
    ]);
  });

  it("attaches the definitions a passage cites, once each, in the order it cites them", () => {
    const definitions = footnoteDefinitions(article);
    expect(footnoteNotes("Banditry spread behind the lines[^2][^3]. Again[^2].", definitions)).toBe(
      [
        '[^2]: [Source B](raw/docs/b.md) — "quote two"',
        '[^3]: [Source C](raw/docs/c.md#^p9) — "quote three"',
      ].join("\n"),
    );
    expect(footnoteNotes("No markers here.", definitions)).toBe("");
  });

  it("takes the first prose sentence, without markers, links or abbreviation cuts", () => {
    expect(openingSentence(article)).toBe(
      "The strikes of 1896 in St. Petersburg drew 30,000 workers.",
    );
  });
});
