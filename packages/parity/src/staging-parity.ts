import type { CompareResult } from "./diff.ts";
import { compareResponses } from "./diff.ts";
import type { CapturedResponse } from "./http.ts";
import { requestBackend } from "./http.ts";
import type { DecisionId, DecisionRule, ManifestEntry, Normalization } from "./manifest.ts";
import {
  asArray,
  asRecord,
  asString,
  baseUrl,
  encodeDocumentPath,
  requiredEnv,
  responseRecord,
} from "./staging-common.ts";

const READ_ONLY_METHODS = new Set(["GET", "HEAD"]);
const PAGE_SIZE = 200;
const decisionIds: readonly DecisionId[] = [
  "D1",
  "D2",
  "D3",
  "D4",
  "D5",
  "D6",
  "D8",
  "D9",
  "D10",
  "D11",
  "D12",
  "D13",
  "D14",
];
const iso = (path: string): Normalization => ({ kind: "isoDate", path });
const dateNormalizations: readonly Normalization[] = [
  iso("created_at"),
  iso("updated_at"),
  iso("completed_at"),
  iso("*.created_at"),
  iso("*.updated_at"),
  iso("items.*.created_at"),
  iso("items.*.updated_at"),
  iso("items.*.completed_at"),
  iso("article.created_at"),
  iso("article.updated_at"),
  iso("outgoing.*.updated_at"),
  iso("incoming.*.updated_at"),
  iso("events.*.ts"),
];

export const assertReadOnlyMethod = (method: string) => {
  if (!READ_ONLY_METHODS.has(method)) {
    throw new Error(`staging parity refuses mutating HTTP method ${method}`);
  }
};

type PairResult = {
  readonly python: CapturedResponse;
  readonly typescript: CapturedResponse;
  readonly comparison: CompareResult;
};

type RunState = {
  readonly pythonUrl: string;
  readonly typescriptUrl: string;
  readonly bearer: string;
  readonly decisionHits: Map<DecisionId, number>;
  readonly endpoints: Set<string>;
  requestCount: number;
};

type ReadSpec = {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly pathTemplate: string;
  readonly method?: "GET" | "HEAD";
  readonly normalize?: readonly Normalization[];
  readonly decision?: DecisionRule;
};

const entryFor = (spec: ReadSpec): ManifestEntry => ({
  id: spec.id,
  phase: "read",
  label: spec.label,
  method: spec.method ?? "GET",
  path: spec.path,
  pathTemplate: spec.pathTemplate,
  coverage: `${spec.method ?? "GET"} ${spec.pathTemplate}`,
  normalize: spec.normalize ?? dateNormalizations,
  decision: spec.decision,
});

const compact = (value: unknown): unknown => {
  if (typeof value === "string" && value.length > 2_000) {
    return `${value.slice(0, 2_000)}… <truncated ${value.length - 2_000} chars>`;
  }
  if (Array.isArray(value)) return value.slice(0, 20).map(compact);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compact(item)]));
  }
  return value;
};

const ruleHits = (state: RunState) =>
  Object.fromEntries(decisionIds.map((id) => [id, state.decisionHits.get(id) ?? 0]));

const fail = (state: RunState, entry: ManifestEntry, result: CompareResult): never => {
  if (result.ok) throw new Error("staging parity internal failure state");
  console.error(
    JSON.stringify(
      {
        status: "FAIL",
        endpoint_count: state.endpoints.size,
        request_count: state.requestCount,
        rule_hits: ruleHits(state),
        request: { method: entry.method, path: entry.path, label: entry.label },
        note: result.note,
        first_diff: compact(result.diffs[0]),
      },
      null,
      2,
    ),
  );
  throw new Error(`staging parity failed at ${entry.method} ${entry.path}`);
};

const readPair = async (state: RunState, spec: ReadSpec): Promise<PairResult> => {
  const entry = entryFor(spec);
  assertReadOnlyMethod(entry.method);
  state.endpoints.add(`${entry.method} ${entry.pathTemplate}`);
  state.requestCount += 1;
  const request = {
    id: entry.id,
    label: entry.label,
    method: entry.method,
    path: entry.path,
    bearer: state.bearer,
  };
  const [python, typescript] = await Promise.all([
    requestBackend({ name: "python", baseUrl: state.pythonUrl }, request),
    requestBackend({ name: "typescript", baseUrl: state.typescriptUrl }, request),
  ]);
  let comparison = compareResponses(entry, python, typescript);
  if (
    !comparison.ok &&
    entry.decision === undefined &&
    python.status === 500 &&
    typescript.status === 404 &&
    entry.pathTemplate.endsWith("/sessions/{session_id}/markdown")
  ) {
    comparison = compareResponses({ ...entry, decision: "D1" }, python, typescript);
  }
  const accepted = comparison;
  if (accepted.ok) {
    for (const decision of accepted.decisions) {
      state.decisionHits.set(decision, (state.decisionHits.get(decision) ?? 0) + 1);
    }
  } else {
    fail(state, entry, accepted);
  }
  return { python, typescript, comparison };
};

const readSseSnapshot = async (
  base: string,
  bearer: string,
  path: string,
): Promise<CapturedResponse> => {
  assertReadOnlyMethod("GET");
  const response = await fetch(`${base}${path}`, {
    method: "GET",
    headers: { authorization: `Bearer ${bearer}` },
    signal: AbortSignal.timeout(10_000),
  });
  const contentType = response.headers.get("content-type");
  if (!response.ok) {
    const text = await response.text();
    return {
      status: response.status,
      contentType,
      body: contentType?.startsWith("application/json") === true ? JSON.parse(text) : text,
      text,
    };
  }
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error(`${path} returned no SSE body`);
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`${path} ended before its first SSE data frame`);
      buffered += decoder.decode(chunk.value, { stream: true });
      const frames = buffered.split("\n\n");
      buffered = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice("data: ".length);
        if (data !== undefined) {
          return {
            status: response.status,
            contentType,
            body: JSON.parse(data) as unknown,
            text: data,
          };
        }
      }
    }
  } finally {
    await reader.cancel();
  }
};

const readJobStream = async (state: RunState, vaultId: string, jobId: string) => {
  const path = `/v1/vaults/${vaultId}/jobs/${jobId}/stream`;
  const entry = entryFor({
    id: `job-stream-${jobId}`,
    label: `job stream ${jobId}`,
    path,
    pathTemplate: "/v1/vaults/{vault_id}/jobs/{job_id}/stream",
  });
  state.endpoints.add(`${entry.method} ${entry.pathTemplate}`);
  state.requestCount += 1;
  const [python, typescript] = await Promise.all([
    readSseSnapshot(state.pythonUrl, state.bearer, path),
    readSseSnapshot(state.typescriptUrl, state.bearer, path),
  ]);
  const comparison = compareResponses(entry, python, typescript);
  if (!comparison.ok) fail(state, entry, comparison);
};

const pageItems = (response: CapturedResponse, label: string) => {
  const body = responseRecord(response, label);
  return asArray(body.items, `${label}.items`);
};

const readPages = async (
  state: RunState,
  input: Omit<ReadSpec, "path"> & { readonly path: string },
) => {
  const items: unknown[] = [];
  let offset = 0;
  while (true) {
    const separator = input.path.includes("?") ? "&" : "?";
    const result = await readPair(state, {
      ...input,
      id: `${input.id}-${offset}`,
      path: `${input.path}${separator}limit=${PAGE_SIZE}&offset=${offset}`,
    });
    if (result.python.status === 401 || result.python.status === 403) {
      throw new Error(
        `${input.label} returned HTTP ${result.python.status} — bearer token dead mid-sweep; refusing to skip silently`,
      );
    }
    if (result.python.status < 200 || result.python.status >= 300) return items;
    const page = pageItems(result.python, input.label);
    items.push(...page);
    const body = responseRecord(result.python, input.label);
    const pagination = asRecord(body.pagination, `${input.label}.pagination`);
    const total = pagination.total;
    if (typeof total !== "number")
      throw new Error(`${input.label}.pagination.total must be a number`);
    offset += page.length;
    if (offset >= total) return items;
    if (page.length === 0)
      throw new Error(`${input.label} pagination stopped before total=${total}`);
  }
};

const fieldStrings = (items: readonly unknown[], field: string, label: string) =>
  items.map((item, index) =>
    asString(asRecord(item, `${label}[${index}]`)[field], `${label}.${field}`),
  );

const readChunks = async (state: RunState, vaultId: string, path: string) => {
  let start = 0;
  while (true) {
    const query = new URLSearchParams({ path, start: String(start), end: String(start + 99) });
    const result = await readPair(state, {
      id: `chunks-${vaultId}-${start}`,
      label: `chunks for ${path}`,
      path: `/v1/vaults/${vaultId}/chunks?${query.toString()}`,
      pathTemplate: "/v1/vaults/{vault_id}/chunks",
    });
    const chunks = asArray(result.python.body, `chunks for ${path}`);
    if (chunks.length < 100) return;
    start += 100;
  }
};

const sweepVault = async (state: RunState, vaultId: string) => {
  await readPair(state, {
    id: `vault-${vaultId}`,
    label: "vault detail",
    path: `/v1/vaults/${vaultId}`,
    pathTemplate: "/v1/vaults/{vault_id}",
  });
  await readPair(state, {
    id: `vault-config-${vaultId}`,
    label: "vault config",
    path: `/v1/vaults/${vaultId}/config`,
    pathTemplate: "/v1/vaults/{vault_id}/config",
  });
  await readPages(state, {
    id: `members-${vaultId}`,
    label: "vault members",
    path: `/v1/vaults/${vaultId}/members`,
    pathTemplate: "/v1/vaults/{vault_id}/members",
  });

  const wikiItems = await readPages(state, {
    id: `wiki-${vaultId}`,
    label: "wiki articles",
    path: `/v1/vaults/${vaultId}/wiki`,
    pathTemplate: "/v1/vaults/{vault_id}/wiki",
  });
  await readPages(state, {
    id: `wiki-recent-${vaultId}`,
    label: "recent wiki articles",
    path: `/v1/vaults/${vaultId}/wiki/recent`,
    pathTemplate: "/v1/vaults/{vault_id}/wiki/recent",
  });
  const sourceItems = await readPages(state, {
    id: `sources-${vaultId}`,
    label: "source documents",
    path: `/v1/vaults/${vaultId}/raw/sources`,
    pathTemplate: "/v1/vaults/{vault_id}/raw/sources",
  });
  const sourceSearchTerm = sourceItems
    .flatMap((item, index) => {
      const source = asRecord(item, `source items[${index}]`);
      return [source.title, source.author];
    })
    .find((value): value is string => typeof value === "string" && value.trim().length > 0)
    ?.trim()
    .slice(0, 64);
  if (sourceSearchTerm !== undefined) {
    await readPages(state, {
      id: `sources-search-${vaultId}`,
      label: "source document search",
      path: `/v1/vaults/${vaultId}/raw/sources?search=${encodeURIComponent(sourceSearchTerm)}`,
      pathTemplate: "/v1/vaults/{vault_id}/raw/sources?search={discovered_term}",
    });
  }
  const sourceType = sourceItems
    .map((item, index) => asRecord(item, `source items[${index}]`).source_type)
    .find((value): value is string => typeof value === "string" && value.length > 0);
  if (sourceType !== undefined) {
    await readPages(state, {
      id: `sources-type-${vaultId}`,
      label: "source type facet",
      path: `/v1/vaults/${vaultId}/raw/sources?source_type=${encodeURIComponent(sourceType)}`,
      pathTemplate: "/v1/vaults/{vault_id}/raw/sources?source_type={discovered_type}",
    });
  }
  const proposalItems = await readPages(state, {
    id: `proposals-${vaultId}`,
    label: "proposals",
    path: `/v1/vaults/${vaultId}/proposals`,
    pathTemplate: "/v1/vaults/{vault_id}/proposals",
  });
  const jobItems = await readPages(state, {
    id: `jobs-${vaultId}`,
    label: "jobs",
    path: `/v1/vaults/${vaultId}/jobs`,
    pathTemplate: "/v1/vaults/{vault_id}/jobs",
  });
  const sessionItems = await readPages(state, {
    id: `sessions-${vaultId}`,
    label: "sessions",
    path: `/v1/vaults/${vaultId}/sessions`,
    pathTemplate: "/v1/vaults/{vault_id}/sessions",
  });
  await readPair(state, {
    id: `lint-${vaultId}`,
    label: "lint report",
    path: `/v1/vaults/${vaultId}/lint`,
    pathTemplate: "/v1/vaults/{vault_id}/lint",
  });
  await readPair(state, {
    id: `costs-${vaultId}`,
    label: "vault costs",
    path: `/v1/vaults/${vaultId}/costs`,
    pathTemplate: "/v1/vaults/{vault_id}/costs",
  });

  const wikiPaths = fieldStrings(wikiItems, "file_path", "wiki items");
  const sourcePaths = fieldStrings(sourceItems, "file_path", "source items");
  for (const path of [...wikiPaths, ...sourcePaths]) {
    await readPair(state, {
      id: `doc-${vaultId}-${path}`,
      label: `document ${path}`,
      path: `/v1/vaults/${vaultId}/doc/${encodeDocumentPath(path)}`,
      pathTemplate: "/v1/vaults/{vault_id}/doc/{path}",
    });
    await readChunks(state, vaultId, path);
  }
  for (const item of wikiItems) {
    const article = asRecord(item, "wiki item");
    const path = asString(article.file_path, "wiki file_path");
    const slug = asString(article.slug, "wiki slug");
    await readPair(state, {
      id: `legacy-wiki-${vaultId}-${slug}`,
      label: `legacy wiki article ${slug}`,
      path: `/v1/vaults/${vaultId}/wiki/${encodeURIComponent(slug)}`,
      pathTemplate: "/v1/vaults/{vault_id}/wiki/{slug}",
      decision: "D4",
    });
    const query = new URLSearchParams({ path });
    await readPair(state, {
      id: `links-${vaultId}-${slug}`,
      label: `links for ${path}`,
      path: `/v1/vaults/${vaultId}/links?${query.toString()}`,
      pathTemplate: "/v1/vaults/{vault_id}/links",
    });
  }
  for (const proposalId of fieldStrings(proposalItems, "id", "proposal items")) {
    await readPair(state, {
      id: `proposal-${proposalId}`,
      label: `proposal ${proposalId}`,
      path: `/v1/vaults/${vaultId}/proposals/${proposalId}`,
      pathTemplate: "/v1/vaults/{vault_id}/proposals/{proposal_id}",
    });
  }
  for (const jobId of fieldStrings(jobItems, "id", "job items")) {
    await readPair(state, {
      id: `job-${jobId}`,
      label: `job ${jobId}`,
      path: `/v1/vaults/${vaultId}/jobs/${jobId}`,
      pathTemplate: "/v1/vaults/{vault_id}/jobs/{job_id}",
    });
    await readJobStream(state, vaultId, jobId);
  }
  for (const sessionId of fieldStrings(sessionItems, "id", "session items")) {
    await readPair(state, {
      id: `session-${sessionId}`,
      label: `session ${sessionId}`,
      path: `/v1/vaults/${vaultId}/sessions/${encodeURIComponent(sessionId)}`,
      pathTemplate: "/v1/vaults/{vault_id}/sessions/{session_id}",
    });
    await readPair(state, {
      id: `session-markdown-${sessionId}`,
      label: `session markdown ${sessionId}`,
      path: `/v1/vaults/${vaultId}/sessions/${encodeURIComponent(sessionId)}/markdown`,
      pathTemplate: "/v1/vaults/{vault_id}/sessions/{session_id}/markdown",
    });
  }
};

const startedAt = Date.now();
const state: RunState = {
  pythonUrl: baseUrl("STAGING_PYTHON_BASE_URL"),
  typescriptUrl: baseUrl("STAGING_TS_BASE_URL"),
  bearer: requiredEnv("STAGING_BEARER_TOKEN"),
  decisionHits: new Map(decisionIds.map((id) => [id, 0])),
  endpoints: new Set(),
  requestCount: 0,
};

await readPair(state, {
  id: "root-health",
  label: "root health",
  path: "/health",
  pathTemplate: "/health",
});
await readPair(state, {
  id: "root-get",
  label: "root GET",
  path: "/",
  pathTemplate: "/",
});
await readPair(state, {
  id: "root-head",
  label: "root HEAD",
  method: "HEAD",
  path: "/",
  pathTemplate: "/",
});
await readPair(state, {
  id: "api-keys",
  label: "API keys",
  path: "/v1/auth/api-keys",
  pathTemplate: "/v1/auth/api-keys",
});
await readPair(state, {
  id: "user-costs",
  label: "user costs",
  path: "/v1/costs",
  pathTemplate: "/v1/costs",
});
const vaultItems = await readPages(state, {
  id: "vaults",
  label: "vaults",
  path: "/v1/vaults",
  pathTemplate: "/v1/vaults",
});
if (vaultItems.length === 0) {
  throw new Error("staging parity discovered zero vaults — the bearer token is bad or the copy is empty; refusing to report PASS on an empty sweep");
}
for (const vaultId of fieldStrings(vaultItems, "id", "vault items")) {
  await sweepVault(state, vaultId);
}

console.log(
  JSON.stringify({
    status: "PASS",
    endpoint_count: state.endpoints.size,
    request_count: state.requestCount,
    vault_count: vaultItems.length,
    rule_hits: ruleHits(state),
    duration_ms: Date.now() - startedAt,
  }),
);
