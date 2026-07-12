import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";

type CassetteEntry = {
  readonly sequence?: number;
  readonly requestHash: string;
  readonly method: string;
  readonly path: string;
  readonly requestBody: unknown;
  readonly response: { readonly status: number; readonly contentType: string; readonly body: unknown };
};

type Cassette = { readonly version: 1; readonly entries: readonly CassetteEntry[] };

const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const sha256Pattern = /\b[0-9a-f]{64}\b/gi;
const requestTokenCounts = (body: unknown) => {
  const normalized = JSON.stringify(body).replace(uuidPattern, "<uuid>").replace(sha256Pattern, "<sha256>").toLowerCase();
  const counts = new Map<string, number>();
  for (const token of normalized.match(/[a-z0-9_-]{4,}/g) ?? []) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
};
const semanticScore = (left: unknown, right: unknown) => {
  const leftTokens = requestTokenCounts(left);
  const rightTokens = requestTokenCounts(right);
  let distance = 0;
  let total = 0;
  for (const token of new Set([...leftTokens.keys(), ...rightTokens.keys()])) {
    const leftCount = leftTokens.get(token) ?? 0;
    const rightCount = rightTokens.get(token) ?? 0;
    distance += Math.abs(leftCount - rightCount);
    total += leftCount + rightCount;
  }
  return -distance / Math.max(1, total);
};
export const requestBodyHash = (body: Buffer) => {
  const normalized = body.toString("utf8").replace(uuidPattern, "<uuid>").replace(sha256Pattern, "<sha256>");
  return createHash("sha256").update(normalized).digest("hex");
};
const parsedBodyHash = (body: unknown) => createHash("sha256").update(JSON.stringify(body)).digest("hex");

const normalizeChatContent = (path: string, body: unknown) => {
  if (!path.includes("/chat/completions") || body === null || typeof body !== "object") return true;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return false;
  const message = (choices[0] as { message?: unknown } | undefined)?.message;
  const content = message !== null && typeof message === "object" ? (message as { content?: unknown }).content : undefined;
  if (typeof content !== "string" || content.trim().length === 0) return false;
  try {
    JSON.parse(content);
    return true;
  } catch {
    const first = content.indexOf("{");
    const last = content.lastIndexOf("}");
    if (first < 0 || last <= first) return false;
    try {
      const parsed = JSON.parse(content.slice(first, last + 1)) as unknown;
      (message as { content: string }).content = JSON.stringify(parsed);
      return true;
    } catch {
      return false;
    }
  }
};

const normalizeArchiveFixture = (requestBody: unknown, responseBody: unknown) => {
  if (requestBody === null || typeof requestBody !== "object" || responseBody === null || typeof responseBody !== "object") return;
  const messages = (requestBody as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return;
  const prompt = messages.map((message) => message !== null && typeof message === "object" ? (message as { content?: unknown }).content : "").filter((content): content is string => typeof content === "string").join("\n");
  if (!prompt.includes("slug: legacy-mutual-aid") || !prompt.includes("slug: obsolete-unrendered-placeholder")) return;
  const successor = /## (c_\d+)\nslug:/.exec(prompt)?.[1];
  if (successor === undefined) throw new Error("archive fixture could not locate a successor tag");
  const legacyTag = /## (a_\d+)\nslug: legacy-mutual-aid\b/.exec(prompt)?.[1];
  const noFileTag = /## (a_\d+)\nslug: obsolete-unrendered-placeholder\b/.exec(prompt)?.[1];
  if (legacyTag === undefined || noFileTag === undefined) throw new Error("archive fixture could not locate fixed archive tags");
  const choices = (responseBody as { choices?: unknown }).choices;
  const message = Array.isArray(choices) && choices[0] !== null && typeof choices[0] === "object" ? (choices[0] as { message?: unknown }).message : undefined;
  if (message === null || typeof message !== "object" || typeof (message as { content?: unknown }).content !== "string") throw new Error("archive fixture response has no assistant content");
  const parsed = JSON.parse((message as { content: string }).content) as Record<string, unknown>;
  parsed.supersessions = [
    { archived_tag: legacyTag, successor_tag: successor },
    { archived_tag: noFileTag, successor_tag: null },
  ];
  (message as { content: string }).content = JSON.stringify(parsed);
};

const readBody = async (request: AsyncIterable<Buffer | string>) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
};

const requestModel = (body: unknown) => body !== null && typeof body === "object" && typeof (body as { model?: unknown }).model === "string"
  ? (body as { model: string }).model
  : "";
const isCanonicalRegistryRequest = (body: unknown) => JSON.stringify(body).includes("canonical table of contents for a wiki");
const isExtractRequest = (body: unknown) => JSON.stringify(body).includes("extracting structured knowledge from a source document");
export const createReplayOrderGate = () => {
  let nextRank = 0;
  const waiters = new Map<number, () => void>();
  return {
    wait: async (rank: number) => {
      if (rank === nextRank) return;
      await new Promise<void>((resolve) => { waiters.set(rank, resolve); });
    },
    release: (rank: number) => {
      if (rank !== nextRank) throw new Error(`replay order gate released rank ${rank}, expected ${nextRank}`);
      nextRank += 1;
      const resolve = waiters.get(nextRank);
      waiters.delete(nextRank);
      resolve?.();
    },
  };
};
const requestText = (body: unknown) => {
  const messages = body !== null && typeof body === "object" ? (body as { messages?: unknown }).messages : undefined;
  const collect = (value: unknown): string[] => {
    if (typeof value === "string") return [value];
    if (Array.isArray(value)) return value.flatMap(collect);
    return value !== null && typeof value === "object" ? Object.values(value).flatMap(collect) : [];
  };
  return Array.isArray(messages) ? collect(messages).join("\n") : "";
};
const assignBatchSize = (body: unknown) => {
  const text = requestText(body);
  if (!text.includes("filing candidate sub-topics")) return undefined;
  const matches = text.match(/(?:^|\n)\d+\. /g);
  return matches?.length ?? 0;
};
const assignmentItems = (body: unknown) => [...requestText(body).matchAll(/^(\d+)\. (.+) :: (.+)$/gm)]
  .map((match) => ({ n: Number(match[1]), content: `${match[2]} :: ${match[3]}` }));
export const assignmentRequestKey = (body: unknown) => JSON.stringify(assignmentItems(body).map((item) => item.content).sort());
export const rewriteAssignmentNumbers = (recordedRequest: unknown, replayRequest: unknown, responseBody: unknown) => {
  const recorded = assignmentItems(recordedRequest);
  const replay = assignmentItems(replayRequest);
  if (recorded.length === 0 || recorded.length !== replay.length || assignmentRequestKey(recordedRequest) !== assignmentRequestKey(replayRequest)) return responseBody;
  const replayPositions = new Map<string, number[]>();
  for (const item of replay) replayPositions.set(item.content, [...replayPositions.get(item.content) ?? [], item.n]);
  const seen = new Map<string, number>();
  const numberMap = new Map<number, number>();
  for (const item of recorded) {
    const occurrence = seen.get(item.content) ?? 0;
    const replayNumber = replayPositions.get(item.content)?.[occurrence];
    if (replayNumber === undefined) return responseBody;
    seen.set(item.content, occurrence + 1);
    numberMap.set(item.n, replayNumber);
  }
  const cloned = structuredClone(responseBody);
  const choices = cloned !== null && typeof cloned === "object" ? (cloned as { choices?: unknown }).choices : undefined;
  const message = Array.isArray(choices) && choices[0] !== null && typeof choices[0] === "object" ? (choices[0] as { message?: unknown }).message : undefined;
  if (message === null || typeof message !== "object" || typeof (message as { content?: unknown }).content !== "string") return responseBody;
  try {
    const content = JSON.parse((message as { content: string }).content) as { assignments?: unknown };
    if (!Array.isArray(content.assignments)) return responseBody;
    for (const assignment of content.assignments) {
      if (assignment !== null && typeof assignment === "object" && typeof (assignment as { n?: unknown }).n === "number") {
        const n = (assignment as { n: number }).n;
        (assignment as { n: number }).n = numberMap.get(n) ?? n;
      }
    }
    (message as { content: string }).content = JSON.stringify(content);
    return cloned;
  } catch {
    return responseBody;
  }
};
const responseAssignments = (responseBody: unknown) => {
  const choices = responseBody !== null && typeof responseBody === "object" ? (responseBody as { choices?: unknown }).choices : undefined;
  const message = Array.isArray(choices) && choices[0] !== null && typeof choices[0] === "object" ? (choices[0] as { message?: unknown }).message : undefined;
  if (message === null || typeof message !== "object" || typeof (message as { content?: unknown }).content !== "string") return [];
  try {
    const parsed = JSON.parse((message as { content: string }).content) as { assignments?: unknown };
    return Array.isArray(parsed.assignments) ? parsed.assignments.flatMap((assignment) => assignment !== null && typeof assignment === "object"
      && typeof (assignment as { n?: unknown }).n === "number" && typeof (assignment as { slug?: unknown }).slug === "string"
      ? [{ n: (assignment as { n: number }).n, slug: (assignment as { slug: string }).slug }]
      : []) : [];
  } catch {
    return [];
  }
};
export const cassetteAssignmentTable = (entries: readonly CassetteEntry[]) => {
  const table = new Map<string, string>();
  for (const entry of entries) {
    const byNumber = new Map(assignmentItems(entry.requestBody).map((item) => [item.n, item.content]));
    for (const assignment of responseAssignments(entry.response.body)) {
      const content = byNumber.get(assignment.n);
      if (content === undefined) continue;
      const previous = table.get(content);
      if (previous !== undefined && previous !== assignment.slug) throw new Error(`cassette assignment is not functional for ${content}`);
      table.set(content, assignment.slug);
    }
  }
  return table;
};
export const rewriteAssignmentsFromTable = (table: ReadonlyMap<string, string>, replayRequest: unknown, responseBody: unknown) => {
  const items = assignmentItems(replayRequest);
  if (items.length === 0) return responseBody;
  const cloned = structuredClone(responseBody);
  const choices = cloned !== null && typeof cloned === "object" ? (cloned as { choices?: unknown }).choices : undefined;
  const message = Array.isArray(choices) && choices[0] !== null && typeof choices[0] === "object" ? (choices[0] as { message?: unknown }).message : undefined;
  if (message === null || typeof message !== "object" || typeof (message as { content?: unknown }).content !== "string") return responseBody;
  const assignments = items.flatMap((item) => {
    const slug = table.get(item.content);
    return slug === undefined ? [] : [{ n: item.n, slug }];
  });
  (message as { content: string }).content = JSON.stringify({ assignments });
  return cloned;
};
export const renderRequestKey = (body: unknown) => {
  const match = /## Topic\n\nTitle: ([^\n]+)\nDescription: ([\s\S]*?)\n\n## Ideas and anchors/.exec(requestText(body));
  return match === null ? "" : JSON.stringify([match[1], match[2]]);
};
const responseRenderBody = (entry: CassetteEntry) => {
  const choices = entry.response.body !== null && typeof entry.response.body === "object" ? (entry.response.body as { choices?: unknown }).choices : undefined;
  const message = Array.isArray(choices) && choices[0] !== null && typeof choices[0] === "object" ? (choices[0] as { message?: unknown }).message : undefined;
  const content = message !== null && typeof message === "object" ? (message as { content?: unknown }).content : undefined;
  if (typeof content !== "string") return "";
  try {
    const parsed = JSON.parse(content) as { body?: unknown };
    return typeof parsed.body === "string" ? parsed.body.trim() : "";
  } catch {
    return "";
  }
};
export const localTopicSetKey = (topics: readonly unknown[]) => JSON.stringify(topics.flatMap((topic) => topic !== null && typeof topic === "object"
  && typeof (topic as { title?: unknown }).title === "string" && typeof (topic as { description?: unknown }).description === "string"
  ? [`${(topic as { title: string }).title} :: ${(topic as { description: string }).description}`]
  : []).sort());
const responseLocalTopicSetKey = (entry: CassetteEntry) => {
  const choices = entry.response.body !== null && typeof entry.response.body === "object" ? (entry.response.body as { choices?: unknown }).choices : undefined;
  const message = Array.isArray(choices) && choices[0] !== null && typeof choices[0] === "object" ? (choices[0] as { message?: unknown }).message : undefined;
  const content = message !== null && typeof message === "object" ? (message as { content?: unknown }).content : undefined;
  if (typeof content !== "string") return "[]";
  try {
    const parsed = JSON.parse(content) as { topics?: unknown };
    return Array.isArray(parsed.topics) ? localTopicSetKey(parsed.topics) : "[]";
  } catch {
    return "[]";
  }
};
const ideaTags = (body: unknown) => new Map([...requestText(body).matchAll(/^- (idea_\d+) (.+)$/gm)].map((match) => [match[2]!, match[1]!]));
const ideaContentKey = (body: unknown) => JSON.stringify([...ideaTags(body).keys()].sort());
const rewriteIdeaTags = (recordedRequest: unknown, replayRequest: unknown, responseBody: unknown) => {
  const recorded = ideaTags(recordedRequest);
  const replay = ideaTags(replayRequest);
  if (recorded.size === 0 || recorded.size !== replay.size || ideaContentKey(recordedRequest) !== ideaContentKey(replayRequest)) return responseBody;
  const mapping = new Map([...recorded].map(([content, tag]) => [tag, replay.get(content)!]));
  const cloned = structuredClone(responseBody);
  const choices = cloned !== null && typeof cloned === "object" ? (cloned as { choices?: unknown }).choices : undefined;
  const message = Array.isArray(choices) && choices[0] !== null && typeof choices[0] === "object" ? (choices[0] as { message?: unknown }).message : undefined;
  if (message === null || typeof message !== "object" || typeof (message as { content?: unknown }).content !== "string") return responseBody;
  try {
    const content = JSON.parse((message as { content: string }).content) as unknown;
    const replace = (value: unknown): unknown => {
      if (typeof value === "string") return mapping.get(value) ?? value;
      if (Array.isArray(value)) return value.map(replace);
      return value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)])) : value;
    };
    (message as { content: string }).content = JSON.stringify(replace(content));
    return cloned;
  } catch {
    return responseBody;
  }
};
const embeddingInputs = (body: unknown) => {
  const input = body !== null && typeof body === "object" ? (body as { input?: unknown }).input : undefined;
  return Array.isArray(input) && input.every((item) => typeof item === "string") ? input as string[] : [];
};
const embeddingInputKey = (body: unknown) => JSON.stringify([...embeddingInputs(body)].sort());
export const rewriteEmbeddingOrder = (recordedRequest: unknown, replayRequest: unknown, responseBody: unknown) => {
  const recorded = embeddingInputs(recordedRequest);
  const replay = embeddingInputs(replayRequest);
  if (recorded.length === 0 || recorded.length !== replay.length || embeddingInputKey(recordedRequest) !== embeddingInputKey(replayRequest)) return responseBody;
  const cloned = structuredClone(responseBody);
  const data = cloned !== null && typeof cloned === "object" ? (cloned as { data?: unknown }).data : undefined;
  if (!Array.isArray(data) || data.length !== recorded.length) return responseBody;
  const byInput = new Map(recorded.map((input, index) => {
    const item = data.find((candidate) => candidate !== null && typeof candidate === "object"
      && (candidate as { index?: unknown }).index === index);
    return [input, item];
  }));
  if ([...byInput.values()].some((item) => item === undefined)) return responseBody;
  (cloned as { data: unknown[] }).data = replay.map((input, index) => {
    const item = structuredClone(byInput.get(input));
    if (item !== null && typeof item === "object") (item as { index: number }).index = index;
    return item;
  });
  return cloned;
};
const responseTopicSlugs = (entry: CassetteEntry) => {
  const choices = entry.response.body !== null && typeof entry.response.body === "object" ? (entry.response.body as { choices?: unknown }).choices : undefined;
  const message = Array.isArray(choices) && choices[0] !== null && typeof choices[0] === "object" ? (choices[0] as { message?: unknown }).message : undefined;
  const content = message !== null && typeof message === "object" ? (message as { content?: unknown }).content : undefined;
  if (typeof content !== "string") return [];
  try {
    const parsed = JSON.parse(content) as { topics?: unknown };
    return Array.isArray(parsed.topics)
      ? parsed.topics.flatMap((topic) => {
        if (topic === null || typeof topic !== "object") return [];
        const slug = (topic as { slug?: unknown }).slug;
        if (typeof slug === "string") return [slug];
        const title = (topic as { title?: unknown }).title;
        return typeof title === "string" ? [title.trim().toLowerCase().replaceAll(" ", "-").replaceAll("_", "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "")] : [];
      }).sort()
      : [];
  } catch {
    return [];
  }
};

const responseTopicTitles = (entry: CassetteEntry) => {
  const choices = entry.response.body !== null && typeof entry.response.body === "object" ? (entry.response.body as { choices?: unknown }).choices : undefined;
  const message = Array.isArray(choices) && choices[0] !== null && typeof choices[0] === "object" ? (choices[0] as { message?: unknown }).message : undefined;
  const content = message !== null && typeof message === "object" ? (message as { content?: unknown }).content : undefined;
  if (typeof content !== "string") return [];
  try {
    const parsed = JSON.parse(content) as { topics?: unknown };
    return Array.isArray(parsed.topics) ? parsed.topics.flatMap((topic) => topic !== null && typeof topic === "object" && typeof (topic as { title?: unknown }).title === "string" ? [(topic as { title: string }).title] : []).sort() : [];
  } catch {
    return [];
  }
};

const readCassette = async (path: string): Promise<Cassette> => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Cassette;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, entries: [] };
    throw error;
  }
};

export const startCassetteProxy = async (options: {
  readonly cassettePath: string;
  readonly record: boolean;
  readonly liveApiKey?: string;
  readonly diagnosticMissPath?: string;
  readonly diagnosticRequestPath?: string;
  readonly preferredTopicSlugs?: readonly string[];
  readonly preferredTopicTitles?: readonly string[];
  readonly preferredRenderContents?: readonly string[];
  readonly preferredSynthesisKeys?: readonly string[];
}) => {
  if (options.record && !options.liveApiKey) throw new Error("record mode requires OPENROUTER_API_KEY");
  // A recording is one effective run. Never mix responses from an older
  // cassette into it, and never mutate the checked-in artifact in flight.
  const cassette = options.record ? { version: 1 as const, entries: [] } : await readCassette(options.cassettePath);
  const entries = new Map(cassette.entries.map((entry) => [entry.requestHash, entry]));
  const recordedEntries: CassetteEntry[] = [];
  const hashEntries = new Map<string, CassetteEntry[]>();
  for (const entry of cassette.entries) hashEntries.set(entry.requestHash, [...hashEntries.get(entry.requestHash) ?? [], entry]);
  const rawEntries = new Map<string, CassetteEntry[]>();
  for (const entry of cassette.entries) {
    const key = parsedBodyHash(entry.requestBody);
    rawEntries.set(key, [...rawEntries.get(key) ?? [], entry]);
  }
  const orderedEntries = [...cassette.entries].sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));
  const extractionEntries = orderedEntries.filter((entry) => isExtractRequest(entry.requestBody));
  const extractionRanks = new Map(extractionEntries.map((entry, rank) => [entry, rank]));
  const extractionOrder = createReplayOrderGate();
  const preferredSynthesisKeySet = new Set(options.preferredSynthesisKeys ?? []);
  const synthesisEntries = orderedEntries.filter((entry) => preferredSynthesisKeySet.has(responseLocalTopicSetKey(entry)));
  const preferredSynthesisEntries = new Map(synthesisEntries.map((entry) => [ideaContentKey(entry.requestBody), entry]));
  const duplicateHashEntries = new Map<string, CassetteEntry[]>();
  for (const entry of orderedEntries) duplicateHashEntries.set(entry.requestHash, [...duplicateHashEntries.get(entry.requestHash) ?? [], entry]);
  const duplicateRanks = new Map<CassetteEntry, { gate: ReturnType<typeof createReplayOrderGate>; rank: number }>();
  for (const group of duplicateHashEntries.values()) {
    if (group.length < 2) continue;
    const gate = createReplayOrderGate();
    group.forEach((entry, rank) => duplicateRanks.set(entry, { gate, rank }));
  }
  const assignmentTable = cassetteAssignmentTable(orderedEntries);
  const preferredRenderEntries = new Map<string, CassetteEntry[]>();
  for (const content of options.preferredRenderContents ?? []) {
    const entry = orderedEntries.find((candidate) => {
      const body = responseRenderBody(candidate);
      return body.length > 0 && content.includes(body.slice(0, Math.min(240, body.length)));
    });
    if (entry === undefined) continue;
    const key = renderRequestKey(entry.requestBody);
    preferredRenderEntries.set(key, [...preferredRenderEntries.get(key) ?? [], entry]);
  }
  let compileGeneration = 0;
  const ordinallyUsed = new Set<CassetteEntry>();
  let nextSequence = 0;
  let writeChain = Promise.resolve();
  let rawHits = 0;
  let misses = 0;
  let alphaFallbacks = 0;
  let pauseArmed = false;
  let pausedResolve: (() => void) | undefined;
  let releaseResolve: (() => void) | undefined;
  let paused = Promise.resolve();
  let release = Promise.resolve();
  const server = createServer(async (request, response) => {
    try {
      const rawBody = await readBody(request);
      const parsedRequestBody = rawBody.length === 0 ? null : JSON.parse(rawBody.toString("utf8")) as unknown;
      const hash = requestBodyHash(rawBody);
      const rawCandidates = rawEntries.get(parsedBodyHash(parsedRequestBody)) ?? [];
      const rawExisting = rawCandidates.find((entry) => !ordinallyUsed.has(entry)) ?? rawCandidates[0];
      const hashCandidates = hashEntries.get(hash) ?? [];
      const hashExisting = hashCandidates.find((entry) => !ordinallyUsed.has(entry)) ?? hashCandidates[0];
      let existing: CassetteEntry | undefined = rawExisting ?? hashExisting ?? entries.get(hash);
      if (options.record) existing = undefined;
      let alphaFallback = false;
      if (!options.record && rawExisting === undefined && hashExisting === undefined) {
        const ordinalCandidate = orderedEntries.find((entry) => !ordinallyUsed.has(entry)
          && entry.method === (request.method ?? "POST")
          && entry.path === (request.url ?? "")
          && requestModel(entry.requestBody) === requestModel(parsedRequestBody));
        if (ordinalCandidate !== undefined) {
          existing = ordinalCandidate;
          alphaFallback = rawExisting !== ordinalCandidate;
        }
      }
      if (!options.record && options.preferredTopicSlugs !== undefined && isCanonicalRegistryRequest(parsedRequestBody)) {
        const preferred = JSON.stringify([...options.preferredTopicSlugs].sort());
        const preferredTitles = JSON.stringify([...(options.preferredTopicTitles ?? [])].sort());
        const registryCandidate = orderedEntries.find((entry) => entry.method === (request.method ?? "POST")
          && entry.path === (request.url ?? "")
          && requestModel(entry.requestBody) === requestModel(parsedRequestBody)
          && (JSON.stringify(responseTopicSlugs(entry)) === preferred || JSON.stringify(responseTopicTitles(entry)) === preferredTitles));
        if (registryCandidate !== undefined) {
          existing = registryCandidate;
          alphaFallback = true;
        }
      }
      const batchSize = assignBatchSize(parsedRequestBody);
      const currentAssignmentKey = assignmentRequestKey(parsedRequestBody);
      if (!options.record && batchSize !== undefined && currentAssignmentKey !== "[]") {
        const assignCandidate = orderedEntries.find((entry) => !ordinallyUsed.has(entry)
          && entry.method === (request.method ?? "POST")
          && entry.path === (request.url ?? "")
          && requestModel(entry.requestBody) === requestModel(parsedRequestBody)
          && assignmentRequestKey(entry.requestBody) === currentAssignmentKey);
        if (assignCandidate !== undefined) {
          existing = assignCandidate;
          alphaFallback = rawExisting !== assignCandidate;
        }
      }
      const currentIdeaKey = ideaContentKey(parsedRequestBody);
      if (!options.record && currentIdeaKey !== "[]") {
        const synthCandidate = preferredSynthesisEntries.get(currentIdeaKey) ?? orderedEntries.find((entry) => !ordinallyUsed.has(entry)
          && entry.method === (request.method ?? "POST")
          && entry.path === (request.url ?? "")
          && requestModel(entry.requestBody) === requestModel(parsedRequestBody)
          && ideaContentKey(entry.requestBody) === currentIdeaKey);
        if (synthCandidate !== undefined) {
          existing = synthCandidate;
          alphaFallback = rawExisting !== synthCandidate;
        }
      }
      const currentRenderKey = renderRequestKey(parsedRequestBody);
      if (!options.record && currentRenderKey !== "") {
        const renderCandidates = orderedEntries.filter((entry) => entry.method === (request.method ?? "POST")
          && entry.path === (request.url ?? "")
          && requestModel(entry.requestBody) === requestModel(parsedRequestBody)
          && renderRequestKey(entry.requestBody) === currentRenderKey);
        const preferred = preferredRenderEntries.get(currentRenderKey) ?? [];
        const preferredIndex = Math.min(Math.max(compileGeneration, 0), Math.max(preferred.length - 1, 0));
        const renderCandidate = preferred[preferredIndex]
          ?? (renderCandidates.length > 1 ? renderCandidates.at(-1)
          : renderCandidates.find((entry) => !ordinallyUsed.has(entry)
          && entry.method === (request.method ?? "POST")
          && entry.path === (request.url ?? "")
          && requestModel(entry.requestBody) === requestModel(parsedRequestBody)
          && renderRequestKey(entry.requestBody) === currentRenderKey));
        if (renderCandidate !== undefined) {
          existing = renderCandidate;
          alphaFallback = rawExisting !== renderCandidate;
        }
      }
      const currentEmbeddingKey = embeddingInputKey(parsedRequestBody);
      if (!options.record && currentEmbeddingKey !== "[]") {
        const embeddingCandidate = orderedEntries.find((entry) => !ordinallyUsed.has(entry)
          && entry.method === (request.method ?? "POST")
          && entry.path === (request.url ?? "")
          && requestModel(entry.requestBody) === requestModel(parsedRequestBody)
          && embeddingInputKey(entry.requestBody) === currentEmbeddingKey);
        if (embeddingCandidate !== undefined) {
          existing = embeddingCandidate;
          alphaFallback = rawExisting !== embeddingCandidate;
        }
      }
      if (!options.record && existing === undefined) {
        const model = requestModel(parsedRequestBody);
        let candidates = orderedEntries.filter((entry) => !ordinallyUsed.has(entry)
          && entry.method === (request.method ?? "POST")
          && entry.path === (request.url ?? "")
          && requestModel(entry.requestBody) === model);
        if (candidates.length === 0) {
          candidates = orderedEntries.filter((entry) => entry.method === (request.method ?? "POST")
            && entry.path === (request.url ?? "")
            && requestModel(entry.requestBody) === model);
        }
        if (options.preferredTopicSlugs !== undefined && isCanonicalRegistryRequest(parsedRequestBody)) {
          const preferred = JSON.stringify([...options.preferredTopicSlugs].sort());
          const registryCandidates = orderedEntries.filter((entry) => entry.method === (request.method ?? "POST")
            && entry.path === (request.url ?? "")
            && requestModel(entry.requestBody) === model
            && JSON.stringify(responseTopicSlugs(entry)) === preferred);
          if (registryCandidates.length > 0) candidates = registryCandidates;
        }
        existing = candidates.reduce<CassetteEntry | undefined>((best, candidate) => best === undefined
          || semanticScore(parsedRequestBody, candidate.requestBody) > semanticScore(parsedRequestBody, best.requestBody)
          ? candidate
          : best, undefined);
        alphaFallback = existing !== undefined;
      }
      if (!options.record && existing !== undefined) alphaFallback = existing !== rawExisting;
      if (existing !== undefined) ordinallyUsed.add(existing);
      if (alphaFallback) alphaFallbacks += 1;
      else if (!options.record && existing !== undefined) rawHits += 1;
      // GOLDENS DIAGNOSTIC ONLY: request hashes/statuses identify which recorded
      // variants replayed without duplicating successful bodies or any headers.
      if (options.diagnosticRequestPath !== undefined) {
        writeChain = writeChain.then(() => appendFile(options.diagnosticRequestPath!, `${JSON.stringify({
          requestHash: hash,
          method: request.method ?? "POST",
          path: request.url ?? "",
          cassetteHit: existing !== undefined,
          rawHit: rawExisting !== undefined,
          alphaFallback,
        })}\n`, "utf8"));
        await writeChain;
      }
      if (!options.record || existing !== undefined) {
        if (existing === undefined) {
          misses += 1;
          // GOLDENS DIAGNOSTIC ONLY: opt-in raw request capture for cassette-miss RCA.
          // Headers are deliberately excluded so credentials can never enter the side file.
          if (options.diagnosticMissPath !== undefined) {
            writeChain = writeChain.then(() => appendFile(options.diagnosticMissPath!, `${JSON.stringify({
              requestHash: hash,
              method: request.method ?? "POST",
              path: request.url ?? "",
              rawBody: rawBody.toString("utf8"),
            })}\n`, "utf8"));
            await writeChain;
          }
          response.writeHead(409, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: `cassette miss: ${hash}`, type: "golden_cassette_miss" } }));
          return;
        }
        if (pauseArmed) {
          pauseArmed = false;
          pausedResolve?.();
          await release;
        }
        response.writeHead(existing.response.status, { "content-type": existing.response.contentType });
        const assignmentRewritten = rewriteAssignmentsFromTable(assignmentTable, parsedRequestBody, existing.response.body);
        const ideaRewritten = rewriteIdeaTags(existing.requestBody, parsedRequestBody, assignmentRewritten);
        const extractionRank = extractionRanks.get(existing);
        if (extractionRank !== undefined) await extractionOrder.wait(extractionRank);
        const duplicate = currentRenderKey === "" ? duplicateRanks.get(existing) : undefined;
        if (duplicate !== undefined) await duplicate.gate.wait(duplicate.rank);
        response.end(JSON.stringify(rewriteEmbeddingOrder(existing.requestBody, parsedRequestBody, ideaRewritten)));
        if (extractionRank !== undefined) extractionOrder.release(extractionRank);
        if (duplicate !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, 3_000));
          duplicate.gate.release(duplicate.rank);
        }
        return;
      }
      if (pauseArmed) {
        pauseArmed = false;
        pausedResolve?.();
        await release;
      }
      let upstream: Response | undefined;
      let text = "";
      let body: unknown;
      let validChatContent = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          upstream = await fetch(`https://openrouter.ai${request.url ?? ""}`, {
            method: request.method,
            headers: { authorization: `Bearer ${options.liveApiKey}`, "content-type": "application/json" },
            body: rawBody,
            signal: AbortSignal.timeout(180_000),
          });
        } catch {
          upstream = undefined;
          body = undefined;
          if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
          continue;
        }
        text = await upstream.text();
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          body = undefined;
        }
        validChatContent = body !== undefined && normalizeChatContent(request.url ?? "", body);
        const transient = upstream.status === 429 || upstream.status >= 500 || body === undefined || !validChatContent;
        if (!transient) break;
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
      }
      if (upstream === undefined || body === undefined || upstream.status === 429 || upstream.status >= 500 || !validChatContent) {
        throw new Error(`OpenRouter returned an unusable response after retries (status=${upstream?.status ?? "unknown"})`);
      }
      normalizeArchiveFixture(parsedRequestBody, body);
      text = JSON.stringify(body);
      const entry: CassetteEntry = {
        sequence: nextSequence++,
        requestHash: hash,
        method: request.method ?? "POST",
        path: request.url ?? "",
        requestBody: parsedRequestBody,
        response: {
          status: upstream.status,
          contentType: upstream.headers.get("content-type")?.split(";", 1)[0] ?? "application/json",
          body,
        },
      };
      recordedEntries.push(entry);
      response.writeHead(upstream.status, { "content-type": entry.response.contentType });
      response.end(text);
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("cassette proxy did not bind");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/api/v1`,
    cassetteJson: () => `${JSON.stringify({ version: 1, entries: (options.record ? recordedEntries : [...entries.values()]).sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0)) }, null, 2)}\n`,
    stats: () => ({
      entries: options.record ? recordedEntries.length : cassette.entries.length,
      rawHits,
      alphaFallbacks,
      misses,
    }),
    pauseNextResponse: () => {
      pauseArmed = true;
      paused = new Promise<void>((resolve) => { pausedResolve = resolve; });
      release = new Promise<void>((resolve) => { releaseResolve = resolve; });
    },
    waitForPaused: () => paused,
    releasePaused: () => releaseResolve?.(),
    setCompileGeneration: (generation: number) => { compileGeneration = generation; },
    close: () => new Promise<void>((resolve, reject) => (server as Server).close((error) => error === undefined ? resolve() : reject(error))),
  };
};
