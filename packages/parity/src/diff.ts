import { isDeepStrictEqual } from "node:util";

import type { CapturedResponse } from "./http.ts";
import { normalizedContentType } from "./http.ts";
import type { DecisionId, ManifestEntry, Normalization } from "./manifest.ts";

export type ComparedResponse = {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: unknown;
  readonly text: string;
};

export type Diff = {
  readonly field: string;
  readonly python: unknown;
  readonly typescript: unknown;
};

export type DecisionEvaluation =
  | {
      readonly accepted: true;
      readonly decisions: readonly DecisionId[];
      readonly note: string;
    }
  | {
      readonly accepted: false;
      readonly note: string;
      readonly diffs: readonly Diff[];
    };

export type CompareResult =
  | {
      readonly ok: true;
      readonly decisions: readonly DecisionId[];
      readonly note?: string;
      readonly python: ComparedResponse;
      readonly typescript: ComparedResponse;
    }
  | {
      readonly ok: false;
      readonly note?: string;
      readonly diffs: readonly Diff[];
      readonly python: ComparedResponse;
      readonly typescript: ComparedResponse;
    };

const cloneJson = (value: unknown): unknown => {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value)) as unknown;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const canonicalIso = (value: unknown): unknown => {
  if (typeof value !== "string") {
    return value;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return value;
  }
  return new Date(parsed).toISOString();
};

const applyAtPath = (
  value: unknown,
  path: readonly string[],
  transform: (input: unknown) => unknown,
): unknown => {
  if (path.length === 0) {
    return transform(value);
  }
  const [head, ...tail] = path;
  if (head === undefined) {
    return value;
  }
  if (head === "*") {
    if (!Array.isArray(value)) {
      return value;
    }
    return value.map((item) => applyAtPath(item, tail, transform));
  }
  if (!isObject(value)) {
    return value;
  }
  if (!(head in value)) {
    return value;
  }
  return {
    ...value,
    [head]: applyAtPath(value[head], tail, transform),
  };
};

const splitPath = (path: string) => path.split(".").filter((part) => part.length > 0);

const normalizeBody = (
  body: unknown,
  normalizations: readonly Normalization[],
  backend: "python" | "typescript",
) => {
  let normalized = cloneJson(body);
  for (const normalization of normalizations) {
    if (normalization.backend !== undefined && normalization.backend !== backend) {
      continue;
    }
    const path = splitPath(normalization.path);
    switch (normalization.kind) {
      case "mask":
        normalized = applyAtPath(normalized, path, () => `<masked:${normalization.label}>`);
        break;
      case "isoDate":
        normalized = applyAtPath(normalized, path, canonicalIso);
        break;
    }
  }
  return normalized;
};

const comparableResponse = (
  response: CapturedResponse,
  entry: ManifestEntry,
  backend: "python" | "typescript",
): ComparedResponse => ({
  status: response.status,
  contentType:
    entry.ignoreContentType === true ? "<ignored>" : normalizedContentType(response.contentType),
  body: normalizeBody(response.body, entry.normalize ?? [], backend),
  text: response.text,
});

const genericDiffs = (python: ComparedResponse, typescript: ComparedResponse): readonly Diff[] => {
  const diffs: Diff[] = [];
  if (python.status !== typescript.status) {
    diffs.push({ field: "status", python: python.status, typescript: typescript.status });
  }
  if (python.contentType !== typescript.contentType) {
    diffs.push({
      field: "content-type",
      python: python.contentType,
      typescript: typescript.contentType,
    });
  }
  if (!isDeepStrictEqual(python.body, typescript.body)) {
    diffs.push({ field: "body", python: python.body, typescript: typescript.body });
  }
  return diffs;
};

const detailString = (value: unknown) =>
  isObject(value) && typeof value.detail === "string" ? value.detail : undefined;

const detailArray = (value: unknown) =>
  isObject(value) && Array.isArray(value.detail) ? value.detail : undefined;

const exactBody = (actual: unknown, expected: unknown) => isDeepStrictEqual(actual, expected);

const terminalProbeBody = (
  id: string,
  status: string,
  phase: string,
  phaseStatus: string,
  error: string,
) => ({
  id,
  vault_id: "<masked:vault_id>",
  trigger: "manual",
  status,
  current_phase: phase,
  phase_status: phaseStatus,
  progress_steps: [],
  error,
  created_at: "<masked:created_at>",
  updated_at: "<masked:updated_at>",
  completed_at: "<masked:completed_at>",
  stream_url: `/jobs/${id}/stream`,
});

const evaluateDecision = (
  entry: ManifestEntry,
  python: ComparedResponse,
  typescript: ComparedResponse,
): DecisionEvaluation | undefined => {
  switch (entry.decision) {
    case undefined:
      return undefined;
    case "D1": {
      const accepted =
        python.status === 500 &&
        typescript.status === 404 &&
        detailString(typescript.body) === "Session markdown not found";
      return accepted
        ? {
            accepted: true,
            decisions: ["D1"],
            note: "D1 missing session markdown sidecar: Python 500, TS intended 404.",
          }
        : { accepted: false, note: "D1 expected Python 500 and TS 404.", diffs: [] };
    }
    case "D3": {
      const accepted =
        python.status === 404 &&
        typescript.status === 403 &&
        detailString(typescript.body) === "Not a member of this vault";
      return accepted
        ? {
            accepted: true,
            decisions: ["D3"],
            note: "D3 unknown vault collapse: Python 404, TS 403.",
          }
        : { accepted: false, note: "D3 expected Python 404 and TS 403.", diffs: [] };
    }
    case "D4": {
      const accepted =
        python.status === 200 &&
        typescript.status === 404 &&
        isObject(python.body) &&
        python.body.slug === "alpha-practice" &&
        typeof python.body.content === "string";
      return accepted
        ? {
            accepted: true,
            decisions: ["D4"],
            note: "D4 legacy /wiki/{slug}: Python serves it, TS intentionally omits it.",
          }
        : { accepted: false, note: "D4 expected Python 200 and TS 404.", diffs: [] };
    }
    case "D6": {
      const accepted =
        python.status === 422 &&
        typescript.status === 422 &&
        detailArray(python.body) !== undefined &&
        detailString(typescript.body) !== undefined;
      return accepted
        ? {
            accepted: true,
            decisions: ["D6"],
            note: "D6 validation body shape: FastAPI detail array, TS flat detail string.",
          }
        : {
            accepted: false,
            note: "D6 expected both 422 with Python array detail and TS string detail.",
            diffs: [],
          };
    }
    case "D8D9": {
      const diffs = genericDiffs(python, typescript);
      return diffs.length === 0
        ? {
            accepted: true,
            decisions: ["D8", "D9"],
            note: "D8/D9 config semantics: storage-backed config now matches.",
          }
        : {
            accepted: false,
            note: "D8/D9 expected config parity after the M1 resolution.",
            diffs,
          };
    }
    case "D10": {
      const accepted = python.status === 200 && typescript.status === 404;
      return accepted
        ? {
            accepted: true,
            decisions: ["D10"],
            note: "D10 archive links: Python serves archive path links, TS returns 404.",
          }
        : { accepted: false, note: "D10 expected Python 200 and TS 404.", diffs: [] };
    }
    case "D11_MULTI_META": {
      const pythonEvents = isObject(python.body) ? python.body.events : undefined;
      const tsEvents = isObject(typescript.body) ? typescript.body.events : undefined;
      const accepted =
        python.status === 200 &&
        typescript.status === 200 &&
        Array.isArray(pythonEvents) &&
        Array.isArray(tsEvents) &&
        pythonEvents.length === 4 &&
        tsEvents.length === 2 &&
        isObject(pythonEvents[0]) &&
        pythonEvents[0].type === "meta" &&
        isObject(pythonEvents[1]) &&
        pythonEvents[1].exId === "ex-stale" &&
        isObject(tsEvents[0]) &&
        tsEvents[0].type === "meta" &&
        isObject(tsEvents[1]) &&
        tsEvents[1].exId === "ex-current";
      return accepted
        ? {
            accepted: true,
            decisions: ["D11"],
            note: "D11 multi-meta replay: Python returns stale prefix, TS isolates final meta.",
          }
        : {
            accepted: false,
            note: "D11 multi-meta expected Python 4 events and TS 2 current events.",
            diffs: [],
          };
    }
    case "D11_INVALID_ID": {
      const accepted = python.status === 404 && typescript.status === 422;
      return accepted
        ? {
            accepted: true,
            decisions: ["D11"],
            note: "D11 invalid session id: Python storage miss 404, TS schema 422.",
          }
        : { accepted: false, note: "D11 invalid id expected Python 404 and TS 422.", diffs: [] };
    }
    case "D11_NON_OBJECT": {
      const tsExpected = {
        id: "s-non-object",
        events: [
          {
            type: "meta",
            id: "s-non-object",
            query: "Non-object event handling",
            ts: "2026-07-09T11:30:00.000Z",
            user_id: "00000000-0000-4000-8000-000000000001",
            origin: null,
          },
          {
            type: "exchange",
            exId: "ex-after-non-object",
            query: "Does TS skip non-object lines?",
            thinking: [],
            answer: "TS skips JSON values that are not objects.",
            ts: "2026-07-09T11:31:00.000Z",
          },
        ],
      };
      const accepted =
        python.status === 500 &&
        typescript.status === 200 &&
        exactBody(typescript.body, tsExpected);
      return accepted
        ? {
            accepted: true,
            decisions: ["D11"],
            note: "D11 non-object JSONL: Python 500, TS skips the line.",
          }
        : {
            accepted: false,
            note: "D11 non-object expected Python 500 and exact TS skipped-line replay.",
            diffs: [],
          };
    }
    case "M4_D12_FAILED_RESURRECTION": {
      const id = "00000000-0000-4000-8000-000000001403";
      const accepted =
        python.status === 200 &&
        typescript.status === 200 &&
        exactBody(
          python.body,
          terminalProbeBody(id, "running", "ingest", "progress", "first attempt failed"),
        ) &&
        exactBody(
          typescript.body,
          terminalProbeBody(id, "failed", "extract", "failed", "first attempt failed"),
        );
      return accepted
        ? {
            accepted: true,
            decisions: ["D12"],
            note: "D12 / M4 oddity 1: Python late progress resurrects failed; TS decision 6 keeps failed terminal-stable.",
          }
        : {
            accepted: false,
            note: "D12 expected Python running/ingest/progress and TS failed/extract/failed.",
            diffs: genericDiffs(python, typescript),
          };
    }
    case "M4_D13_CANCELLED_RESURRECTION": {
      const id = "00000000-0000-4000-8000-000000001404";
      const accepted =
        python.status === 200 &&
        typescript.status === 200 &&
        exactBody(
          python.body,
          terminalProbeBody(id, "running", "ingest", "progress", "Cancelled by user"),
        ) &&
        exactBody(
          typescript.body,
          terminalProbeBody(id, "cancelled", "abstract", "failed", "Cancelled by user"),
        );
      return accepted
        ? {
            accepted: true,
            decisions: ["D13"],
            note: "D13 / M4 oddity 2: Python late progress resurrects cancelled; TS decision 6 keeps cancelled terminal-stable.",
          }
        : {
            accepted: false,
            note: "D13 expected Python running/ingest/progress and TS cancelled/abstract/failed.",
            diffs: genericDiffs(python, typescript),
          };
    }
    case "M4_D14_CANCELLED_CLOBBER": {
      const id = "00000000-0000-4000-8000-000000001405";
      const accepted =
        python.status === 200 &&
        typescript.status === 200 &&
        exactBody(
          python.body,
          terminalProbeBody(id, "failed", "render", "failed", "late failure"),
        ) &&
        exactBody(
          typescript.body,
          terminalProbeBody(id, "cancelled", "render", "failed", "Cancelled by user"),
        );
      return accepted
        ? {
            accepted: true,
            decisions: ["D14"],
            note: "D14 / M4 oddity 22: Python late failure clobbers cancelled; TS decision 6 preserves cancellation.",
          }
        : {
            accepted: false,
            note: "D14 expected Python failed/late failure and TS cancelled/original cancellation.",
            diffs: genericDiffs(python, typescript),
          };
    }
    case "M3_D2_TITLE_NULL": {
      const diffs = genericDiffs(python, typescript);
      const accepted =
        diffs.length === 0 &&
        python.status === 201 &&
        isObject(python.body) &&
        python.body.title === null &&
        typescript.status === 201 &&
        isObject(typescript.body) &&
        typescript.body.title === null;
      return accepted
        ? {
            accepted: true,
            decisions: ["D2"],
            note: "D2 promote fresh title stays null in both backends; frontend nullable-title fix is separate.",
          }
        : {
            accepted: false,
            note: "D2 expected both fresh promote responses to carry title: null.",
            diffs,
          };
    }
    case "M3_D3_BTW_CONTEXT": {
      const diffs = genericDiffs(python, typescript);
      const pythonEvents = isObject(python.body) ? python.body.events : undefined;
      const tsEvents = isObject(typescript.body) ? typescript.body.events : undefined;
      const pythonBtw =
        Array.isArray(pythonEvents) && isObject(pythonEvents[2]) ? pythonEvents[2] : undefined;
      const tsBtw = Array.isArray(tsEvents) && isObject(tsEvents[2]) ? tsEvents[2] : undefined;
      const accepted =
        diffs.length === 0 &&
        python.status === 200 &&
        typescript.status === 200 &&
        pythonBtw?.type === "btw" &&
        pythonBtw.context === "<masked:btw_context>" &&
        tsBtw?.type === "btw" &&
        tsBtw.context === "<masked:btw_context>";
      return accepted
        ? {
            accepted: true,
            decisions: ["D3"],
            note: "D3 BTW context: Python drops context on write; TS persists the frontend-sent context.",
          }
        : {
            accepted: false,
            note: "D3 expected only the backend-specific BTW context difference after normalization.",
            diffs,
          };
    }
    case "M3_D5_PROMOTE_MISSING_SESSION": {
      const accepted =
        python.status === 500 &&
        typescript.status === 404 &&
        detailString(typescript.body) === "Session not found";
      return accepted
        ? {
            accepted: true,
            decisions: ["D5"],
            note: "D5 promote missing session: Python 500, TS intended 404.",
          }
        : {
            accepted: false,
            note: "D5 expected Python 500 and TS 404 for nonexistent session promote.",
            diffs: [],
          };
    }
  }
};

export const compareResponses = (
  entry: ManifestEntry,
  pythonResponse: CapturedResponse,
  typescriptResponse: CapturedResponse,
): CompareResult => {
  const python = comparableResponse(pythonResponse, entry, "python");
  const typescript = comparableResponse(typescriptResponse, entry, "typescript");
  const decision = evaluateDecision(entry, python, typescript);
  if (decision !== undefined) {
    if (decision.accepted) {
      return { ok: true, decisions: decision.decisions, note: decision.note, python, typescript };
    }
    const diffs = decision.diffs.length > 0 ? decision.diffs : genericDiffs(python, typescript);
    return { ok: false, note: decision.note, diffs, python, typescript };
  }
  const diffs = genericDiffs(python, typescript);
  return diffs.length === 0
    ? { ok: true, decisions: [], python, typescript }
    : { ok: false, diffs, python, typescript };
};
