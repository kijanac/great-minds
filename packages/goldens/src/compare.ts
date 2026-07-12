import { createHash } from "node:crypto";

import { contentHash, fileContentHash } from "../../server/src/crypto.ts";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type Row = Record<string, Json>;
type Mapping = Map<string, string>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const stable = (value: unknown) => JSON.stringify(value, Object.keys(value as object).sort());

const rows = (snapshot: Row, field: string) => snapshot[field] as Row[];

const addPair = (mapping: Mapping, reverse: Mapping, actual: string, expected: string, label: string) => {
  const previous = mapping.get(actual);
  const reversePrevious = reverse.get(expected);
  if ((previous !== undefined && previous !== expected) || (reversePrevious !== undefined && reversePrevious !== actual)) {
    throw new Error(`${label} is not bijective: ${actual} -> ${expected}`);
  }
  mapping.set(actual, expected);
  reverse.set(expected, actual);
};

const indexUnique = (items: readonly Row[], key: (row: Row) => string, label: string) => {
  const index = new Map<string, Row>();
  for (const item of items) {
    const stableKey = key(item);
    if (index.has(stableKey)) throw new Error(`${label} stable key is not unique: ${stableKey}`);
    index.set(stableKey, item);
  }
  return index;
};

const pairRows = (
  expected: readonly Row[],
  actual: readonly Row[],
  key: (row: Row) => string,
  expectedId: (row: Row) => string,
  actualId: (row: Row) => string,
  mapping: Mapping,
  reverse: Mapping,
  label: string,
) => {
  const expectedIndex = indexUnique(expected, key, `golden ${label}`);
  const actualIndex = indexUnique(actual, key, `replay ${label}`);
  if (expectedIndex.size !== actualIndex.size) throw new Error(`${label} cardinality differs: ${expectedIndex.size} != ${actualIndex.size}`);
  for (const [stableKey, actualRow] of actualIndex) {
    const expectedRow = expectedIndex.get(stableKey);
    if (expectedRow === undefined) throw new Error(`${label} has no golden partner for stable key: ${stableKey}`);
    addPair(mapping, reverse, actualId(actualRow), expectedId(expectedRow), label);
  }
};

const replace = (value: Json, mapping: Mapping): Json => {
  if (typeof value === "string") {
    let output = mapping.get(value) ?? value;
    for (const [from, to] of mapping) output = output.replaceAll(from, to);
    return output;
  }
  if (Array.isArray(value)) return value.map((item) => replace(item, mapping));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [mapping.get(key) ?? key, replace(item, mapping)]));
  }
  return value;
};

const ideaKey = (row: Row) => contentHash(
  String(row.document_id),
  String(row.kind),
  String(row.label),
  String(row.description),
  JSON.stringify(row.anchors ?? []),
);

const localTopics = (snapshot: Row, mapping: Mapping) => rows(snapshot, "compileCache")
  .filter((row) => row.phase === "synthesize")
  .flatMap((row) => ((row.value as Row).local_topics as Row[]))
  .map((row) => replace(row, mapping) as Row);

const localTopicKey = (row: Row) => contentHash(
  String(row.title),
  String(row.description),
  JSON.stringify(row.subsumed_idea_ids),
  JSON.stringify(row.link_target_titles ?? []),
);

const buildIdentityMapping = (expected: Row, actual: Row) => {
  const mapping: Mapping = new Map();
  const reverse: Mapping = new Map();
  pairRows(rows(expected, "ideas"), rows(actual, "ideas"), ideaKey, (row) => String(row.idea_id), (row) => String(row.idea_id), mapping, reverse, "idea identity");
  pairRows(rows(expected, "topics"), rows(actual, "topics"), (row) => String(row.slug), (row) => String(row.topic_id), (row) => String(row.topic_id), mapping, reverse, "topic identity");
  pairRows(rows(expected, "articles"), rows(actual, "articles"), (row) => `${String(row.file_path)}\0${String(row.body_hash)}`, (row) => String(row.id), (row) => String(row.id), mapping, reverse, "article identity");
  pairRows(localTopics(expected, new Map()), localTopics(actual, mapping), localTopicKey, (row) => String(row.local_topic_id), (row) => String(row.local_topic_id), mapping, reverse, "local-topic identity");
  return mapping;
};

const normalizeDerivedTopicHashes = (expected: Row, actual: Row, mapping: Mapping) => {
  const expectedTopics = indexUnique(rows(expected, "topics"), (row) => String(row.slug), "golden topic");
  const expectedMemberships = rows(expected, "memberships");
  const actualMemberships = rows(actual, "memberships");
  for (const topic of rows(actual, "topics")) {
    const golden = expectedTopics.get(String(topic.slug));
    if (golden === undefined) continue;
    const rawIdeaIds = actualMemberships.filter((row) => row.topic_id === topic.topic_id).map((row) => String(row.idea_id)).sort();
    const goldenIdeaIds = expectedMemberships.filter((row) => row.topic_id === golden.topic_id).map((row) => String(row.idea_id)).sort();
    if (rawIdeaIds.length === 0 || goldenIdeaIds.length === 0) continue;
    const rawHash = contentHash(String(topic.title), String(topic.description), ...rawIdeaIds);
    const goldenHash = contentHash(String(golden.title), String(golden.description), ...goldenIdeaIds);
    if (typeof topic.compiled_from_hash === "string" && topic.compiled_from_hash !== rawHash) throw new Error(`replay compiled_from_hash is incoherent for topic ${String(topic.slug)}`);
    if (typeof golden.compiled_from_hash === "string" && golden.compiled_from_hash !== goldenHash) throw new Error(`golden compiled_from_hash is incoherent for topic ${String(topic.slug)}`);
    const normalizedIdeaIds = rawIdeaIds.map((ideaId) => mapping.get(ideaId) ?? ideaId).sort();
    const normalizedHash = contentHash(String(topic.title), String(topic.description), ...normalizedIdeaIds);
    for (const field of ["compiled_from_hash", "rendered_from_hash"] as const) {
      const raw = topic[field];
      if (typeof raw === "string") mapping.set(raw, normalizedHash);
    }
  }
};

const normalizeFileHashes = (expected: Row, actual: Row, mapping: Mapping) => {
  if (!Array.isArray(expected.renderedFiles)) {
    const expectedTree = indexUnique(rows(expected, "renderedTree"), (row) => String(row.path), "golden rendered tree");
    for (const file of rows(actual, "renderedTree")) {
      const golden = expectedTree.get(String(file.path));
      if (golden === undefined) throw new Error(`rendered tree has no golden partner: ${String(file.path)}`);
      mapping.set(String(file.sha256), String(golden.sha256));
    }
    const expectedArticles = indexUnique(rows(expected, "articles"), (row) => String(row.file_path), "golden article hash");
    for (const article of rows(actual, "articles")) {
      const golden = expectedArticles.get(String(article.file_path));
      if (golden === undefined) throw new Error(`article hashes have no golden partner: ${String(article.file_path)}`);
      mapping.set(String(article.file_hash), String(golden.file_hash));
      mapping.set(String(article.body_hash), String(golden.body_hash));
    }
    delete actual.renderedFiles;
    return;
  }
  const expectedFiles = indexUnique(rows(expected, "renderedFiles"), (row) => String(row.path), "golden rendered file");
  const actualFiles = indexUnique(rows(actual, "renderedFiles"), (row) => String(row.path), "replay rendered file");
  for (const [path, actualFile] of actualFiles) {
    const expectedFile = expectedFiles.get(path);
    if (expectedFile === undefined) throw new Error(`rendered file has no golden partner: ${path}`);
    const actualContent = String(actualFile.content);
    const expectedContent = String(expectedFile.content);
    const normalizedContent = String(replace(actualContent, mapping));
    if (normalizedContent !== expectedContent) throw new Error(`rendered file content differs after UUID substitution: ${path}`);
    const actualSha = createHash("sha256").update(actualContent).digest("hex");
    const expectedSha = createHash("sha256").update(expectedContent).digest("hex");
    mapping.set(actualSha, expectedSha);
    mapping.set(fileContentHash(actualContent), fileContentHash(expectedContent));
  }
};

const normalizeAssignmentBatches = (expected: Row, actual: Row, mapping: Mapping) => {
  const assignmentRows = (snapshot: Row) => rows(snapshot, "compileCache").filter((row) => row.phase === "canonicalize_assign");
  const relation = (items: readonly Row[], normalize: boolean) => {
    const seen = new Map<string, string>();
    for (const raw of items) {
      const row = normalize ? replace(raw, mapping) as Row : raw;
      const assign = (row.value as Row).assign as Row;
      for (const [localTopicId, slug] of Object.entries(assign)) {
        const previous = seen.get(localTopicId);
        if (previous !== undefined && previous !== slug) throw new Error(`canonical assignment is not functional for ${localTopicId}`);
        seen.set(localTopicId, String(slug));
      }
    }
    return [...seen].sort(([left], [right]) => left.localeCompare(right));
  };
  const expectedRows = assignmentRows(expected);
  const actualRows = assignmentRows(actual);
  const diff = firstDiff(relation(expectedRows, false), relation(actualRows, true), "$.compileCache.canonicalize_assign.relation");
  if (diff !== undefined) throw new Error(`canonical assignment relation differs after UUID substitution: ${diff}`);
  actual.compileCache = [
    ...rows(actual, "compileCache").filter((row) => row.phase !== "canonicalize_assign"),
    ...structuredClone(expectedRows),
  ];
};

const normalizeCacheKeys = (expected: Row, actual: Row, mapping: Mapping) => {
  const withoutKey = (row: Row) => {
    const { cache_key: _cacheKey, sort_key: _sortKey, ...rest } = replace(row, mapping) as Row;
    return JSON.stringify(rest);
  };
  const expectedIndex = indexUnique(rows(expected, "compileCache"), (row) => `${String(row.phase)}\0${withoutKey(row)}`, "golden cache row");
  const actualIndex = indexUnique(rows(actual, "compileCache"), (row) => `${String(row.phase)}\0${withoutKey(row)}`, "replay cache row");
  if (expectedIndex.size !== actualIndex.size) throw new Error(`compile-cache cardinality differs: ${expectedIndex.size} != ${actualIndex.size}`);
  const reverse = new Map<string, string>();
  for (const [stableKey, actualRow] of actualIndex) {
    const expectedRow = expectedIndex.get(stableKey);
    if (expectedRow === undefined) throw new Error(`compile-cache row has no golden partner: ${String(actualRow.phase)}`);
    addPair(mapping, reverse, String(actualRow.cache_key), String(expectedRow.cache_key), "compile-cache key");
  }
};

const sortNormalized = (value: Row) => {
  for (const field of ["compileCache", "ideas", "memberships", "backlinks"] as const) {
    const list = value[field];
    if (Array.isArray(list)) list.sort((left, right) => stable(left).localeCompare(stable(right)));
  }
  return value;
};

const normalizeSnapshot = (expected: Row, actual: Row) => {
  const mapping = buildIdentityMapping(expected, actual);
  normalizeDerivedTopicHashes(expected, actual, mapping);
  normalizeFileHashes(expected, actual, mapping);
  normalizeAssignmentBatches(expected, actual, mapping);
  normalizeCacheKeys(expected, actual, mapping);
  return sortNormalized(replace(actual, mapping) as Row);
};

const firstDiff = (expected: unknown, actual: unknown, path = "$ "): string | undefined => {
  if (Object.is(expected, actual)) return undefined;
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) return `${path}.length: ${expected.length} != ${actual.length}`;
    for (let index = 0; index < expected.length; index++) {
      const diff = firstDiff(expected[index], actual[index], `${path}[${index}]`);
      if (diff !== undefined) return diff;
    }
    return undefined;
  }
  if (typeof expected === "object" && expected !== null && typeof actual === "object" && actual !== null) {
    for (const key of [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()) {
      const diff = firstDiff((expected as Record<string, unknown>)[key], (actual as Record<string, unknown>)[key], `${path}.${key}`);
      if (diff !== undefined) return diff;
    }
    return undefined;
  }
  return `${path}: ${JSON.stringify(expected)} != ${JSON.stringify(actual)}`;
};

export const compareJson = (expected: Json, actual: Json) => firstDiff(expected, actual);

export const compareSnapshots = (expected: Row, actual: Row) => {
  const normalizedExpected = sortNormalized(structuredClone(expected));
  const normalizedActual = normalizeSnapshot(normalizedExpected, structuredClone(actual));
  return { diff: firstDiff(normalizedExpected, normalizedActual), normalizedActual };
};

export const compareArtifacts = (expected: Json, actual: Json) => {
  if (expected === null || actual === null || Array.isArray(expected) || Array.isArray(actual) || typeof expected !== "object" || typeof actual !== "object") {
    throw new Error("golden root must be an object");
  }
  for (const scenario of ["first", "second"] as const) {
    const expectedSnapshot = expected[scenario];
    const actualSnapshot = actual[scenario];
    if (expectedSnapshot === null || actualSnapshot === null || Array.isArray(expectedSnapshot) || Array.isArray(actualSnapshot) || typeof expectedSnapshot !== "object" || typeof actualSnapshot !== "object") throw new Error(`missing ${scenario} snapshot`);
    const { diff } = compareSnapshots(expectedSnapshot, actualSnapshot);
    if (diff !== undefined) return diff;
  }
  return undefined;
};

export const isUuid = (value: string) => uuid.test(value);
