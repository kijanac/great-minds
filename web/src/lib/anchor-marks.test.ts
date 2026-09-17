import { describe, expect, it } from "vitest";

import { uniqueQuoteSpan } from "$lib/anchor";
import { wrapAnchors } from "$lib/anchor-marks";
import { parseMarkdown } from "$lib/markdown";

describe("saved passage anchors", () => {
  it("preserves a paragraph association without highlighting either repeated phrase", () => {
    const result = wrapAnchors(parseMarkdown("The claim matters. The claim needs evidence."), [
      { threadId: "recovered", blockOffset: 0, quote: "The claim" },
    ]);
    expect(result.misses).toEqual([
      { threadId: "recovered", blockOffset: 0, quote: "The claim", reason: "quote-unresolved" },
    ]);
    expect(JSON.stringify(result.tree)).not.toContain('"tagName":"mark"');
  });

  it("highlights a unique quote across formatting and keeps the original text", () => {
    const result = wrapAnchors(parseMarkdown("A **clear** claim."), [
      { threadId: "saved", blockOffset: 0, quote: "clear claim" },
    ]);
    expect(result.misses).toEqual([]);
    expect(JSON.stringify(result.tree)).toContain('"dataThreadId":"saved"');
    expect(JSON.stringify(result.tree)).toContain('"tagName":"strong"');
  });

  it("does not treat overlapping occurrences as a unique selection", () => {
    expect(uniqueQuoteSpan("banana", "ana")).toBeNull();
    expect(uniqueQuoteSpan("A clear claim.", "clear claim")).toEqual({ start: 2, end: 13 });
  });
});
