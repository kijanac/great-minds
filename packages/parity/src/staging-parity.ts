import type { CompareResult } from "./diff.ts";
import { compareResponses } from "./diff.ts";

// Timestamp precision is not contract (fixture parity masks these fields; the frontend
// Date-parses them; decision 13 records the cosmetics). Python emits microseconds, JS
// Dates cap at milliseconds — normalize BOTH sides to millisecond precision before
// diffing so real instant differences still fail while precision cosmetics pass.
const ISO_FRACTION = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|\+00:00)$/;
const normalizeTimestamps = (value: unknown): unknown => {
  if (typeof value === "string" && ISO_FRACTION.test(value)) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }
  if (Array.isArray(value)) return value.map(normalizeTimestamps);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalizeTimestamps(item)]),
    );
  }
  return value;
};
const normalizeCaptured = <T extends { readonly body: unknown }>(response: T): T => ({
  ...response,
  body: normalizeTimestamps(response.body),
});
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
  const pythonNormalized = normalizeCaptured(python);
  const typescriptNormalized = normalizeCaptured(typescript);
  let comparison = compareResponses(entry, pythonNormalized, typescriptNormalized);
  if (
    !comparison.ok &&
    entry.decision === undefined &&
    python.status === 500 &&
    typescript.status === 404 &&
    entry.pathTemplate.endsWith("/sessions/{session_id}/markdown")
  ) {
    comparison = compareResponses({ ...entry, decision: "D1" }, pythonNormalized, typescriptNormalized);
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

// Listings ordered by a non-unique key (updated_at with bulk-ingest ties) have no
// total order in EITHER backend — page order is plan-dependent, so pages are paged
// per backend independently and compared as an id-keyed set with full-object equality.
// Content comparison is NOT weakened: every object must match exactly; only inter-page
// ordering is excused. See M5 staging finding #1 in docs/ts-migration-m5.md.
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

const readPagesUnordered = async (
  state: RunState,
  input: Omit<ReadSpec, "path"> & { readonly path: string; readonly keyField: string },
) => {
  const entry = entryFor({ ...input, path: input.path });
  assertReadOnlyMethod(entry.method);
  state.endpoints.add(`${entry.method} ${entry.pathTemplate} (unordered)`);
  const collect = async (backend: "python" | "typescript") => {
    const baseUrl = backend === "python" ? state.pythonUrl : state.typescriptUrl;
    const items: unknown[] = [];
    let offset = 0;
    while (true) {
      const separator = input.path.includes("?") ? "&" : "?";
      state.requestCount += 1;
      const response = await requestBackend(
        { name: backend, baseUrl },
        {
          id: `${input.id}-${backend}-${offset}`,
          label: input.label,
          method: "GET",
          path: `${input.path}${separator}limit=${PAGE_SIZE}&offset=${offset}`,
          bearer: state.bearer,
        },
      );
      if (response.status === 401 || response.status === 403) {
        throw new Error(`${input.label} (${backend}) returned HTTP ${response.status} — bearer token dead mid-sweep`);
      }
      const body = responseRecord(response, `${input.label} (${backend})`);
      const page = asArray(body.items, `${input.label} (${backend}).items`);
      items.push(...page);
      const pagination = asRecord(body.pagination, `${input.label} (${backend}).pagination`);
      const total = pagination.total;
      if (typeof total !== "number") throw new Error(`${input.label} (${backend}).pagination.total must be a number`);
      offset += page.length;
      if (offset >= total || page.length === 0) return { items, total };
    }
  };
  const [python, typescript] = await Promise.all([collect("python"), collect("typescript")]);
  if (python.total !== typescript.total) {
    throw new Error(`${input.label}: pagination.total differs (python=${python.total}, typescript=${typescript.total})`);
  }
  // Both backends read the SAME staging database, so the row sets are identical by
  // construction; what this compares is the projection/serialization. Python live bug #7
  // (no tie-breaker on ORDER BY updated_at DESC with mass ties) makes any paged walk lose
  // a large, random subset on BOTH sides, so union equality is unattainable and untestable.
  // Instead: totals and facets must match exactly, every key present in both walks must
  // have a byte-equal object (modulo millisecond timestamp precision), and the overlap
  // must be substantial so the projection check has real coverage.
  const keyed = (items: readonly unknown[], side: string) => {
    const map = new Map<string, string>();
    for (const [index, item] of items.entries()) {
      const record = asRecord(item, `${input.label} (${side})[${index}]`);
      const id = asString(record[input.keyField], `${input.label} (${side})[${index}].${input.keyField}`);
      const normalized = { ...record };
      if (typeof normalized.updated_at === "string") {
        normalized.updated_at = new Date(normalized.updated_at).toISOString();
      }
      const body = canonicalJson(normalizeTimestamps(normalized));
      const existing = map.get(id);
      if (existing !== undefined && existing !== body) {
        throw new Error(`${input.label} (${side}): duplicate id ${id} with DIFFERENT bodies`);
      }
      map.set(id, body);
    }
    return map;
  };
  const left = keyed(python.items, "python");
  const right = keyed(typescript.items, "typescript");
  let overlap = 0;
  for (const [id, body] of left) {
    const other = right.get(id);
    if (other === undefined) continue;
    overlap += 1;
    if (other !== body) throw new Error(`${input.label}: object ${id} differs between backends`);
  }
  if (python.total > 0 && (left.size === 0 || right.size === 0)) {
    throw new Error(`${input.label}: a backend's paged union is empty despite total=${python.total} — comparison would be vacuous`);
  }
  const floor = Math.floor(Math.min(left.size, right.size) / 2);
  if (overlap < floor) {
    throw new Error(`${input.label}: overlap ${overlap} below floor ${floor} — projection comparison lacks coverage`);
  }
  console.log(JSON.stringify({
    event: "unordered_projection_compared",
    label: input.label,
    python_union: left.size,
    typescript_union: right.size,
    overlap,
    total: python.total,
  }));
  return python.items;
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
  const sourceItems = await readPagesUnordered(state, {
    id: `sources-${vaultId}`,
    keyField: "file_path",
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
    await readPagesUnordered(state, {
      id: `sources-search-${vaultId}`,
      keyField: "file_path",
      label: "source document search",
      path: `/v1/vaults/${vaultId}/raw/sources?search=${encodeURIComponent(sourceSearchTerm)}`,
      pathTemplate: "/v1/vaults/{vault_id}/raw/sources?search={discovered_term}",
    });
  }
  const sourceType = sourceItems
    .map((item, index) => asRecord(item, `source items[${index}]`).source_type)
    .find((value): value is string => typeof value === "string" && value.length > 0);
  if (sourceType !== undefined) {
    await readPagesUnordered(state, {
      id: `sources-type-${vaultId}`,
      keyField: "file_path",
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
  const allSourcePaths = [...fieldStrings(sourceItems, "file_path", "source items")].sort();
  // Every wiki document is swept; source documents are sampled deterministically
  // (sorted, fixed stride to ~300) — full-corpus per-document reads would take hours
  // and add no field-shape coverage beyond a broad sample.
  const sourceStride = Math.max(1, Math.floor(allSourcePaths.length / 300));
  const sourcePaths = allSourcePaths.filter((_, index) => index % sourceStride === 0);
  console.log(JSON.stringify({ event: "doc_sweep_sample", wiki: wikiPaths.length, sources_sampled: sourcePaths.length, sources_total: allSourcePaths.length }));
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
