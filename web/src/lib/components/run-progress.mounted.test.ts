import type { RunStage } from "@great-minds/domain";
import { flushSync, mount, unmount } from "svelte";
import { expect, it } from "vitest";

import RunProgress from "./run-progress.svelte";

const step = (
  key: string,
  label: string,
  status: RunStage["steps"][number]["status"],
  done: number | null = null,
  total: number | null = null,
) => ({ key, label, status, done, total, detail: "" });

const track: RunStage[] = [
  {
    key: "reading",
    label: "Reading",
    title: "Reading your sources",
    status: "completed",
    steps: [step("extract_cards", "Reading sources", "completed", 8355, 8355)],
    warnings: [
      {
        phase: "extract",
        message: "of 8355 documents could not be read",
        count: 22,
        items: ["Das Kapital", "Das Kapital"],
      },
    ],
  },
  {
    key: "writing",
    label: "Writing",
    title: "Writing articles",
    status: "running",
    steps: [step("write_articles", "Writing articles", "running", 212, 428)],
    warnings: [],
  },
  {
    key: "linking",
    label: "Linking",
    title: "Linking articles",
    status: "pending",
    steps: [step("link_articles", "Linking articles", "pending")],
    warnings: [],
  },
];

const text = (element: Element | null | undefined) =>
  element?.textContent?.replace(/\s+/g, " ").trim();

it("leads with the current stage, its count and where it sits in the run; other stages open on tap", () => {
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(RunProgress, {
    target,
    props: {
      track,
      running: true,
      startedAt: new Date(Date.now() - 75 * 60_000),
      completedAt: null,
    },
  });
  flushSync();
  expect(text(target.querySelector("h1"))).toBe("Writing articles");
  expect(target.querySelector("[role=progressbar]")?.getAttribute("aria-valuenow")).toBe("212");
  expect(text(target.querySelector("[role=progressbar]")?.nextElementSibling)).toBe(
    "212 of 428 step 2 of 3",
  );
  expect(text(target.querySelector("ul"))).toBe("• Writing articles 212 / 428");
  expect(text(target.querySelector(".border-destructive"))).toBe(
    "Left out: 22 of 8355 documents could not be read which Das Kapital",
  );
  expect(text(target.querySelector("p:last-of-type"))).toMatch(/running for 1 h 15 min$/);

  [...target.querySelectorAll<HTMLButtonElement>("ol button")][0]?.click();
  flushSync();
  expect(text(target.querySelector("ul"))).toBe("✓ Reading sources 8,355");

  unmount(component);
  target.remove();
});
