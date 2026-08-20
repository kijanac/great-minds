import { describe, expect, it } from "vitest";

import { resolveCompositionIdentity } from "../src/compile-contract.ts";

const ideas = (prefix: string, count: number) =>
  Array.from({ length: count }, (_value, index) => `${prefix}${index}`);

describe("resolveCompositionIdentity", () => {
  it("carries identity on an exact slug match even without membership rows", () => {
    const resolution = resolveCompositionIdentity(
      [{ topicId: "t1", slug: "stable", ideaIds: [] }],
      [{ slug: "stable", ideaIds: ideas("a", 4) }],
    );
    expect(resolution.carries.get(0)).toBe("t1");
    expect(resolution.archived.size).toBe(0);
    expect(resolution.residue).toEqual([]);
  });

  it("skips slug matching when the slug collides between canonicals", () => {
    const resolution = resolveCompositionIdentity(
      [{ topicId: "t1", slug: "dup", ideaIds: [] }],
      [
        { slug: "dup", ideaIds: ideas("a", 4) },
        { slug: "dup", ideaIds: ideas("b", 4) },
      ],
    );
    expect(resolution.carries.size).toBe(0);
    expect(resolution.residue).toEqual(["t1"]);
  });

  it("carries a renamed topic whose composition survives intact", () => {
    const resolution = resolveCompositionIdentity(
      [{ topicId: "t1", slug: "old-name", ideaIds: ideas("a", 6) }],
      [{ slug: "new-name", ideaIds: ideas("a", 6) }],
    );
    expect(resolution.carries.get(0)).toBe("t1");
    expect(resolution.archived.size).toBe(0);
    expect(resolution.residue).toEqual([]);
  });

  it("archives an absorbed topic with its successor instead of carrying", () => {
    const resolution = resolveCompositionIdentity(
      [{ topicId: "t1", slug: "small", ideaIds: ideas("a", 3) }],
      [{ slug: "umbrella", ideaIds: [...ideas("a", 3), ...ideas("b", 5)] }],
    );
    expect(resolution.carries.size).toBe(0);
    expect(resolution.archived.get("t1")).toBe(0);
    expect(resolution.residue).toEqual([]);
  });

  it("tracks a split into its dominant piece", () => {
    const prior = { topicId: "t1", slug: "wide", ideaIds: ideas("a", 10) };
    const resolution = resolveCompositionIdentity(
      [prior],
      [
        { slug: "major", ideaIds: [...ideas("a", 10).slice(0, 7), ...ideas("b", 8)] },
        { slug: "minor", ideaIds: ideas("a", 10).slice(7) },
      ],
    );
    expect(resolution.archived.get("t1")).toBe(0);
    expect(resolution.residue).toEqual([]);
  });

  it("sends an ambiguous split to the residue", () => {
    const [half, rest] = [ideas("a", 10).slice(0, 5), ideas("a", 10).slice(5)];
    const resolution = resolveCompositionIdentity(
      [{ topicId: "t1", slug: "wide", ideaIds: ideas("a", 10) }],
      [
        { slug: "left", ideaIds: [...half, ...ideas("b", 6)] },
        { slug: "right", ideaIds: [...rest, ...ideas("c", 6)] },
      ],
    );
    expect(resolution.carries.size).toBe(0);
    expect(resolution.archived.size).toBe(0);
    expect(resolution.residue).toEqual(["t1"]);
  });

  it("lets the dominant prior carry a merge and archives the rest into it", () => {
    const resolution = resolveCompositionIdentity(
      [
        { topicId: "t1", slug: "big", ideaIds: ideas("a", 6) },
        { topicId: "t2", slug: "small", ideaIds: ideas("b", 3) },
      ],
      [{ slug: "merged", ideaIds: [...ideas("a", 6), ...ideas("b", 3)] }],
    );
    expect(resolution.carries.get(0)).toBe("t1");
    expect(resolution.archived.get("t2")).toBe(0);
    expect(resolution.residue).toEqual([]);
  });

  it("breaks a tied carry conflict deterministically and archives the loser", () => {
    const universe = ideas("a", 10);
    const resolution = resolveCompositionIdentity(
      [
        { topicId: "t2", slug: "late", ideaIds: universe.slice(4) },
        { topicId: "t1", slug: "early", ideaIds: universe.slice(0, 6) },
      ],
      [{ slug: "merged", ideaIds: universe }],
    );
    expect(resolution.carries.get(0)).toBe("t1");
    expect(resolution.archived.get("t2")).toBe(0);
  });

  it("leaves priors with too few surviving ideas to the residue", () => {
    const resolution = resolveCompositionIdentity(
      [
        { topicId: "t1", slug: "thin", ideaIds: ideas("a", 2) },
        { topicId: "t2", slug: "vanished", ideaIds: ideas("z", 8) },
      ],
      [{ slug: "unrelated", ideaIds: [...ideas("a", 2), ...ideas("b", 6)] }],
    );
    expect(resolution.residue.toSorted()).toEqual(["t1", "t2"]);
  });

  it("handles an empty canonical set by leaving every prior to the residue", () => {
    const resolution = resolveCompositionIdentity(
      [{ topicId: "t1", slug: "any", ideaIds: ideas("a", 5) }],
      [],
    );
    expect(resolution.residue).toEqual(["t1"]);
  });
});
