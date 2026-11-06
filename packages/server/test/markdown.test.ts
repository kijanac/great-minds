import { describe, expect, it } from "vitest";

import {
  footnoteDefinitions,
  footnoteNotes,
  markdownParagraphs,
  openingSentence,
  withoutFootnoteDefinitions,
} from "../src/markdown.ts";

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
