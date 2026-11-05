import type { RunOutcome } from "@great-minds/domain";
import { flushSync, mount, unmount } from "svelte";
import { expect, it } from "vitest";

import Fixture from "./run-outcome-fixture.svelte";

const article = (n: number) => ({ title: `Article ${n}`, file_path: `wiki/article-${n}.md` });

type Stopped = {
  readonly kind: "failed" | "cancelled";
  readonly stage: string | null;
};

const render = (outcome: RunOutcome | null, stopped: Stopped | null = null) => {
  const opened: string[] = [];
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(Fixture, {
    target,
    props: { outcome, stopped, onOpen: (path: string) => opened.push(path) },
  });
  flushSync();
  const text = (selector: string) =>
    [...target.querySelectorAll(selector)].map((node) =>
      node.textContent?.replace(/\s+/g, " ").trim(),
    );
  return {
    target,
    opened,
    text,
    done: () => {
      unmount(component);
      target.remove();
    },
  };
};

it("names what an Update changed, a few titles per group with the rest one tap away", () => {
  const view = render({
    sources: 14,
    added: [1, 2, 3, 4, 5, 6, 7].map(article),
    changed: [article(8), article(9)],
    removed: [{ title: "Old topic", file_path: "archive/x/old-topic.md" }],
    unchanged: 414,
  });
  expect(view.text("h1")).toEqual(["7 new articles, 2 updated, 1 removed"]);
  expect(view.text("p")).toEqual(["From 14 new or edited sources."]);
  expect(view.text("h2")).toEqual(["New", "Updated", "Removed"]);
  expect(view.text("section:first-of-type li")).toEqual([
    "Article 1",
    "Article 2",
    "Article 3",
    "Article 4",
    "Article 5",
    "show all 7",
  ]);
  view.target.querySelector<HTMLButtonElement>("section:first-of-type li button")?.click();
  expect(view.opened).toEqual(["wiki/article-1.md"]);
  [...view.target.querySelectorAll<HTMLButtonElement>("button")]
    .find((b) => b.textContent?.includes("show all"))
    ?.click();
  flushSync();
  expect(view.text("section:first-of-type li")).toHaveLength(7);
  view.done();
});

it("says plainly when nothing changed", () => {
  const view = render({ sources: 0, added: [], changed: [], removed: [], unchanged: 428 });
  expect(view.text("h1")).toEqual(["Nothing changed"]);
  expect(view.text("h2")).toEqual([]);
  expect(view.text("p")).toEqual([]);
  view.done();
});

it("a failed run names where it stopped and lists the articles it had already changed", () => {
  const view = render(
    {
      sources: 3,
      added: [article(1)],
      changed: [],
      removed: [{ title: "Old topic", file_path: "archive/x/old-topic.md" }],
      unchanged: 427,
    },
    { kind: "failed", stage: "Linking articles" },
  );
  expect(view.text("h1")).toEqual(["Update stopped while linking articles"]);
  expect(view.text("p")).toEqual([]);
  expect(view.text("h2")).toEqual(["New", "Removed"]);
  view.done();
});

it("a cancelled run that changed nothing shows only its title", () => {
  const view = render(
    { sources: 0, added: [], changed: [], removed: [], unchanged: 428 },
    { kind: "cancelled", stage: null },
  );
  expect(view.text("h1")).toEqual(["Update cancelled"]);
  expect(view.text("p")).toEqual([]);
  expect(view.text("h2")).toEqual([]);
  view.done();
});

it("an old run without a record shows only where it stopped", () => {
  const view = render(null, { kind: "failed", stage: "Writing articles" });
  expect(view.text("h1")).toEqual(["Update stopped while writing articles"]);
  expect(view.text("p")).toEqual([]);
  view.done();
});
