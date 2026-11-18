import { describe, expect, it } from "vitest";

import { capturePassage } from "./anchor";
import { selectionExcerpt } from "./selection-passage";

const paragraph = (html: string) => {
  document.body.innerHTML = `<p>${html}</p>`;
  return document.querySelector("p")!;
};

describe("selectionExcerpt", () => {
  it("completes cut words and drops footnote markers", () => {
    const block = paragraph(
      'be liable to arrest and court martial<sup><a data-footnote-ref="">2</a></sup>. The principle must be applied in practice.',
    );
    const first = block.firstChild as Text;
    const last = block.lastChild as Text;
    const range = document.createRange();
    range.setStart(first, 1);
    range.setEnd(last, last.data.indexOf("practice") + 3);

    expect(selectionExcerpt(range)).toBe(
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

    expect(selectionExcerpt(range)).toBe("Discipline must be tightened at once.");
  });

  it("captures a selection's paragraph, section and which repeat of the quote it is", () => {
    document.body.innerHTML = [
      '<p data-block-offset="0" id="^p4">The claim matters.</p>',
      '<p data-block-offset="20">The claim<sup><button data-citation-ref="1">1</button></sup> holds; the claim stands.</p>',
    ].join("");
    const block = document.querySelectorAll("p")[1]!;
    const text = block.lastChild as Text;
    const range = document.createRange();
    range.setStart(text, text.data.indexOf("the claim") + 4);
    range.setEnd(text, text.data.indexOf("the claim") + 9);
    expect(capturePassage(range, block)).toEqual({
      quote: "claim",
      context: "The claim holds; the claim stands.",
      section: 4,
      occurrence: 3,
    });
  });
});
