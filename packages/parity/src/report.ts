import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { CompareResult, Diff } from "./diff.ts";
import type { DecisionId, ManifestEntry } from "./manifest.ts";

export type RequestReport = {
  readonly entry: ManifestEntry;
  readonly result: CompareResult;
};

export type RunReport = {
  readonly startedAt: string;
  readonly durationMs: number;
  readonly mutationCount: number;
  readonly readCount: number;
  readonly endpointCount: number;
  readonly decisionHits: ReadonlyMap<DecisionId, number>;
  readonly requests: readonly RequestReport[];
  readonly exclusions: readonly string[];
};

const json = (value: unknown) => JSON.stringify(value, null, 2);

const diffMarkdown = (diff: Diff) => `- ${diff.field}

  Python:
  \`\`\`json
  ${json(diff.python)}
  \`\`\`

  TypeScript:
  \`\`\`json
  ${json(diff.typescript)}
  \`\`\``;

const requestLine = (report: RequestReport) => {
  const status = report.result.ok ? "PASS" : "FAIL";
  const decision = report.result.ok && report.result.decisions.length > 0
    ? ` (${report.result.decisions.join("+")})`
    : "";
  return `| ${status}${decision} | ${report.entry.method} | \`${report.entry.pathTemplate}\` | ${report.entry.label} |`;
};

export const summarizeRun = (report: RunReport) => {
  const failures = report.requests.filter((request) => !request.result.ok);
  const decisionSummary = [...report.decisionHits.entries()]
    .map(([decision, count]) => `${decision}=${count}`)
    .join(", ");
  return [
    `Parity ${failures.length === 0 ? "PASS" : "FAIL"}`,
    `requests=${report.requests.length}`,
    `endpoints=${report.endpointCount}`,
    `mutations=${report.mutationCount}`,
    `reads=${report.readCount}`,
    `decisions=${decisionSummary}`,
    `duration_ms=${report.durationMs}`,
  ].join(" ");
};

export const writeReport = async (path: string, report: RunReport) => {
  const failures = report.requests.filter((request) => !request.result.ok);
  const decisions = [...report.decisionHits.entries()]
    .map(([decision, count]) => `- ${decision}: ${count}`)
    .join("\n");
  const failureDetails = failures
    .map((request) => {
      if (request.result.ok) {
        return "";
      }
      const note = request.result.note === undefined ? "" : `\n\n${request.result.note}`;
      return `### ${request.entry.id} — ${request.entry.method} ${request.entry.pathTemplate}${note}

${request.result.diffs.map(diffMarkdown).join("\n\n")}`;
    })
    .filter((section) => section.length > 0)
    .join("\n\n");
  const body = `# API Parity Report

- Started: ${report.startedAt}
- Duration: ${(report.durationMs / 1000).toFixed(2)}s
- Endpoints covered: ${report.endpointCount}
- Requests: ${report.requests.length} (${report.mutationCount} mutation, ${report.readCount} read)
- Failures: ${failures.length}

## Decision Hits

${decisions}

## Endpoint Exclusions

${report.exclusions.length === 0 ? "- None" : report.exclusions.map((item) => `- ${item}`).join("\n")}

## Request Matrix

| Result | Method | Path | Variant |
|---|---:|---|---|
${report.requests.map(requestLine).join("\n")}

## Failures

${failureDetails.length === 0 ? "No unlicensed diffs." : failureDetails}
`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, "utf8");
};
