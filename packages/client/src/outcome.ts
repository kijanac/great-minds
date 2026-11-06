import type { RunOutcome } from "@great-minds/domain";

export const plural = (count: number, word: string) =>
  `${count.toLocaleString("en-US")} ${word}${count === 1 ? "" : "s"}`;

export const isFirstBuild = (outcome: RunOutcome) =>
  outcome.unchanged === 0 && outcome.changed.length === 0 && outcome.added.length > 0;

export const changedNothing = (outcome: RunOutcome) =>
  outcome.added.length === 0 && outcome.changed.length === 0 && outcome.removed.length === 0;

export const outcomeHeadline = (outcome: RunOutcome) => {
  if (isFirstBuild(outcome)) return `Your library has ${plural(outcome.added.length, "article")}`;
  if (changedNothing(outcome)) return "Nothing changed";
  return [
    outcome.added.length > 0 ? plural(outcome.added.length, "new article") : "",
    outcome.changed.length > 0 ? `${outcome.changed.length} updated` : "",
    outcome.removed.length > 0 ? `${outcome.removed.length} removed` : "",
  ]
    .filter((part) => part !== "")
    .join(", ");
};

export const stoppedHeadline = (kind: "failed" | "cancelled", stage: string | null) =>
  kind === "cancelled"
    ? "Update cancelled"
    : stage === null
      ? "Update stopped"
      : `Update stopped while ${stage.toLowerCase()}`;
