import { describe, expect, it } from "vitest";

import { citationsOf } from "@great-minds/domain";

import { numberCitations, outlineOf } from "./citations";
import { parseMarkdown } from "./markdown";
import type { HastNode } from "./markdown-plugins";

const answer = [
  "Intro citing [Letter to Martov, 1903](raw/docs/a.md#%5Ep4) and [the RSDLP article](wiki/rsdlp.md).",
  "",
  "## I. Origins",
  "",
  "Again [Letter to Martov](raw/docs/a.md) and [a web page](https://example.com) and [Theses](raw/docs/b.md#^p2).",
  "",
  "### Later *years*",
].join("\n");

const citedNumbers = (node: HastNode): string[] => [
  ...(typeof node.properties?.dataCitation === "string" ? [node.properties.dataCitation] : []),
  ...(node.children ?? []).flatMap(citedNumbers),
];

describe("answer citations", () => {
  it("numbers each cited library document once, in first-cited order, ignoring web links", () => {
    expect(citationsOf(answer)).toEqual([
      {
        n: 1,
        label: "Letter to Martov, 1903",
        href: "raw/docs/a.md#%5Ep4",
        path: "raw/docs/a.md",
        kind: "source",
      },
      {
        n: 2,
        label: "the RSDLP article",
        href: "wiki/rsdlp.md",
        path: "wiki/rsdlp.md",
        kind: "article",
      },
      { n: 3, label: "Theses", href: "raw/docs/b.md#^p2", path: "raw/docs/b.md", kind: "source" },
    ]);
  });

  it("marks every link to a cited document with its number, repeats included", () => {
    expect(citedNumbers(numberCitations(parseMarkdown(answer), citationsOf(answer)))).toEqual([
      "1",
      "2",
      "1",
      "3",
    ]);
  });

  it("lists the answer's section headings without markup", () => {
    expect(outlineOf(answer)).toEqual(["I. Origins", "Later years"]);
  });
});
