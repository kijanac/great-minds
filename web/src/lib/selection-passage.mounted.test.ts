import { describe, expect, it } from "vitest";

import { selectionPassage } from "./selection-passage";

const paragraph = (html: string) => {
  document.body.innerHTML = `<p>${html}</p>`;
  return document.querySelector("p")!;
};

describe("selectionPassage", () => {
  it("completes cut words and drops footnote markers", () => {
    const block = paragraph(
      'be liable to arrest and court martial<sup><a data-footnote-ref="">2</a></sup>. The principle must be applied in practice.',
    );
    const first = block.firstChild as Text;
    const last = block.lastChild as Text;
    const range = document.createRange();
    range.setStart(first, 1);
    range.setEnd(last, last.data.indexOf("practice") + 3);

    expect(selectionPassage(range)).toBe(
      "be liable to arrest and court martial. The principle must be applied in practice.",
    );
  });

  it("keeps a whole-word selection and removes adjacent citation markers", () => {
    const block = paragraph(
      'Discipline must be tightened<sup><a data-footnote-ref="">7</a></sup><sup class="footnote-sep">,</sup><sup><a data-footnote-ref="">8</a></sup> at once.',
    );
    const range = document.createRange();
    range.setStart(block.firstChild!, 0);
    range.setEnd(block.lastChild!, " at once.".length);

    expect(selectionPassage(range)).toBe("Discipline must be tightened at once.");
  });
});
