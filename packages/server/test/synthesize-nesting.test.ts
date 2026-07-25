import { describe, expect, it } from "vitest";

import {
  applyNestingFloor,
  findNestingViolations,
  type LocalTopic,
} from "../src/compile-llm-core.ts";

const topic = (id: string, ideas: readonly string[]): LocalTopic => ({
  localTopicId: id,
  chunkIdx: 0,
  slug: id,
  title: id,
  description: `about ${id}`,
  subsumedIdeaIds: [...ideas].toSorted(),
});

const ideas = (prefix: string, count: number, start = 1) =>
  Array.from({ length: count }, (_v, index) => `${prefix}${start + index}`);

const covered = (topics: readonly LocalTopic[]) =>
  new Set(topics.flatMap((entry) => [...entry.subsumedIdeaIds]));

describe("findNestingViolations", () => {
  it("ignores lateral partial overlap below the containment threshold", () => {
    const a = topic("a", [...ideas("x", 10), ...ideas("s", 4)]);
    const b = topic("b", [...ideas("y", 10), ...ideas("s", 4)]);
    expect(findNestingViolations([a, b])).toEqual([]);
  });

  it("detects a strictly smaller topic contained at >= 0.8", () => {
    const umbrella = topic("u", ideas("x", 20));
    const facet = topic("f", ideas("x", 10));
    expect(findNestingViolations([umbrella, facet])).toEqual([{ umbrella: 0, facets: [1] }]);
  });

  it("treats 4-of-5 containment as nested and equal-size twins as premerge territory", () => {
    const umbrella = topic("u", ideas("x", 20));
    const nearFacet = topic("f", [...ideas("x", 4), "z1"]);
    expect(findNestingViolations([umbrella, nearFacet])).toEqual([{ umbrella: 0, facets: [1] }]);
    const twinA = topic("t1", ideas("x", 6));
    const twinB = topic("t2", ideas("x", 6));
    expect(findNestingViolations([twinA, twinB])).toEqual([]);
  });
});

describe("applyNestingFloor", () => {
  it("shrinks an umbrella to its residue and keeps facets whole", () => {
    const umbrella = topic("u", ideas("x", 30));
    const facet = topic("f", ideas("x", 12));
    const result = applyNestingFloor([umbrella, facet], findNestingViolations([umbrella, facet]));
    expect(result).toHaveLength(2);
    expect(result[0].subsumedIdeaIds).toEqual(ideas("x", 18, 13).toSorted());
    expect(result[1]).toBe(facet);
    expect(covered(result)).toEqual(covered([umbrella, facet]));
  });

  it("drops a fully faceted umbrella without losing ideas", () => {
    const umbrella = topic("u", ideas("x", 20));
    const facetA = topic("fa", ideas("x", 12));
    const facetB = topic("fb", ideas("x", 12, 9));
    const input = [umbrella, facetA, facetB];
    const result = applyNestingFloor(input, findNestingViolations(input));
    expect(result.map((entry) => entry.localTopicId)).toEqual(["fa", "fb"]);
    expect(covered(result)).toEqual(covered(input));
  });

  it("drops a tiny residue only when its ideas survive elsewhere", () => {
    const coveredUmbrella = topic("u1", ideas("x", 12));
    const coveringFacet = topic("f1", ideas("x", 10));
    const lateral = topic("l1", ["x11", "x12", "z1", "z2", "z3", "z4"]);
    const droppable = [coveredUmbrella, coveringFacet, lateral];
    const dropped = applyNestingFloor(droppable, findNestingViolations(droppable));
    expect(dropped.map((entry) => entry.localTopicId)).toEqual(["f1", "l1"]);
    expect(covered(dropped)).toEqual(covered(droppable));

    const orphanUmbrella = topic("u2", ideas("y", 12));
    const orphanFacet = topic("f2", ideas("y", 10));
    const kept = applyNestingFloor(
      [orphanUmbrella, orphanFacet],
      findNestingViolations([orphanUmbrella, orphanFacet]),
    );
    expect(kept.map((entry) => entry.localTopicId)).toEqual(["u2", "f2"]);
    expect(kept[0].subsumedIdeaIds).toEqual(["y11", "y12"]);
    expect(covered(kept)).toEqual(covered([orphanUmbrella, orphanFacet]));
  });

  it("resolves multi-level nesting from original sets without orphaning", () => {
    const grand = topic("g", ideas("x", 40));
    const middle = topic("m", ideas("x", 20));
    const leaf = topic("l", ideas("x", 10));
    const input = [grand, middle, leaf];
    const result = applyNestingFloor(input, findNestingViolations(input));
    expect(result.map((entry) => entry.localTopicId)).toEqual(["g", "m", "l"]);
    expect(result[0].subsumedIdeaIds).toEqual(ideas("x", 20, 21).toSorted());
    expect(result[1].subsumedIdeaIds).toEqual(ideas("x", 10, 11).toSorted());
    expect(result[2].subsumedIdeaIds).toEqual(ideas("x", 10).toSorted());
    expect(covered(result)).toEqual(covered(input));
  });
});
