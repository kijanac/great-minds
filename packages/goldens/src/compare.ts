import { createHash } from "node:crypto";

import { contentHash, fileContentHash } from "../../server/src/crypto.ts";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type Row = Record<string, Json>;
type Mapping = Map<string, string>;

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
  expectedKey: (row: Row) => string,
  actualKey: (row: Row) => string,
  expectedId: (row: Row) => string,
  actualId: (row: Row) => string,
  mapping: Mapping,
  reverse: Mapping,
  label: string,
) => {
  const expectedIndex = indexUnique(expected, expectedKey, `golden ${label}`);
  const actualIndex = indexUnique(actual, actualKey, `replay ${label}`);
  if (expectedIndex.size !== actualIndex.size) {
    const missing = [...expectedIndex.keys()].filter((key) => !actualIndex.has(key));
    const extra = [...actualIndex.keys()].filter((key) => !expectedIndex.has(key));
    throw new Error(
      `${label} cardinality differs: ${expectedIndex.size} != ${actualIndex.size}; missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`,
    );
  }
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

const ideaKey = (snapshot: Row, row: Row) => contentHash(
  String(row.document_id),
  String(row.kind),
  String(row.label),
  String(row.description),
  JSON.stringify(rows(snapshot, "ideaAnchors")
    .filter((anchor) => anchor.idea_id === row.idea_id)
    .map(({ sort_key: _sortKey, idea_id: _ideaId, ...anchor }) => anchor)
    .sort((left, right) => Number(left.chunk_index) - Number(right.chunk_index) || Number(left.position) - Number(right.position))),
);

const localTopics = (snapshot: Row, mapping: Mapping) => rows(snapshot, "compileCache")
  .filter((row) => row.phase === "synthesize")
  .flatMap((row) => ((row.value as Row).local_topics as Row[]))
  .map((row) => replace(row, mapping) as Row);

const premergedLocalTopics = (snapshot: Row) => {
  const contract = contractPart(snapshot, "canonicalizeRegistry");
  const threshold = Number(contract.premergeJaccardThreshold);
  const ordered = localTopics(snapshot, new Map()).sort((left, right) => Number(left.chunk_idx) - Number(right.chunk_idx)
    || String(left.local_topic_id).localeCompare(String(right.local_topic_id)));
  const parent = ordered.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[index] !== index) {
      const next = parent[index]!;
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left: number, right: number) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    parent[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
  };
  const groupBy = (key: (topic: Row) => string) => {
    const groups = new Map<string, number[]>();
    ordered.forEach((topic, index) => {
      const value = key(topic);
      if (value.length > 0) groups.set(value, [...groups.get(value) ?? [], index]);
    });
    for (const indices of groups.values()) for (const index of indices.slice(1)) union(indices[0]!, index);
  };
  groupBy((topic) => String(topic.slug ?? ""));
  groupBy((topic) => String(topic.title).trim().toLowerCase());
  const ideaSets = ordered.map((topic) => new Set((topic.subsumed_idea_ids as Json[]).map(String)));
  for (let left = 0; left < ordered.length; left++) {
    for (let right = left + 1; right < ordered.length; right++) {
      if (find(left) === find(right)) continue;
      const leftIdeas = ideaSets[left]!;
      const rightIdeas = ideaSets[right]!;
      const unionSize = new Set([...leftIdeas, ...rightIdeas]).size;
      if (unionSize > 0 && [...leftIdeas].filter((idea) => rightIdeas.has(idea)).length / unionSize > threshold) union(left, right);
    }
  }
  const groups = new Map<number, number[]>();
  ordered.forEach((_, index) => {
    const root = find(index);
    groups.set(root, [...groups.get(root) ?? [], index]);
  });
  return [...groups.values()].map((indices) => {
    const representative = ordered[indices[0]!]!;
    const ideas = [...new Set(indices.flatMap((index) => (ordered[index]!.subsumed_idea_ids as Json[]).map(String)))].sort();
    return { ...representative, subsumed_idea_ids: ideas } as Row;
  }).sort((left, right) => String(left.slug).localeCompare(String(right.slug)));
};

const localTopicKey = (row: Row) => contentHash(
  String(row.title),
  String(row.description),
  JSON.stringify(row.subsumed_idea_ids),
  JSON.stringify(row.link_target_titles ?? []),
);

const buildIdentityMapping = (expected: Row, actual: Row) => {
  const mapping: Mapping = new Map();
  const reverse: Mapping = new Map();
  pairRows(rows(expected, "ideas"), rows(actual, "ideas"), (row) => ideaKey(expected, row), (row) => ideaKey(actual, row), (row) => String(row.idea_id), (row) => String(row.idea_id), mapping, reverse, "idea identity");
  pairRows(rows(expected, "topics"), rows(actual, "topics"), (row) => String(row.slug), (row) => String(row.slug), (row) => String(row.topic_id), (row) => String(row.topic_id), mapping, reverse, "topic identity");
  pairRows(rows(expected, "articles"), rows(actual, "articles"), (row) => `${String(row.file_path)}\0${String(row.body_hash)}`, (row) => `${String(row.file_path)}\0${String(row.body_hash)}`, (row) => String(row.id), (row) => String(row.id), mapping, reverse, "article identity");
  pairRows(localTopics(expected, new Map()), localTopics(actual, mapping), localTopicKey, localTopicKey, (row) => String(row.local_topic_id), (row) => String(row.local_topic_id), mapping, reverse, "local-topic identity");
  return mapping;
};

const phaseRows = (snapshot: Row, phase: string) => rows(snapshot, "compileCache").filter((row) => row.phase === phase);

const contractPart = (snapshot: Row, name: string) => {
  const contract = snapshot.cacheKeyContract as Row;
  const part = contract[name];
  if (part === null || Array.isArray(part) || typeof part !== "object") throw new Error(`missing cache-key contract inputs for ${name}`);
  return part as Row;
};

const requireKeyMultiset = (label: string, cacheRows: readonly Row[], expectedKeys: readonly string[]) => {
  const actualKeys = cacheRows.map((row) => String(row.cache_key)).sort();
  const sortedExpected = [...expectedKeys].sort();
  const diff = firstDiff(sortedExpected, actualKeys, `$.compileCache.${label}.constructedKeys`);
  if (diff !== undefined) throw new Error(`${label} cache-key construction differs: ${diff}`);
};

const VERIFIED_CACHE_PHASES = new Set(["extract", "partition", "synthesize", "canonicalize_registry", "canonicalize_assign", "render"]);

export const verifyCacheKeyConstruction = (snapshot: Row) => {
  if (snapshot.schemaVersion !== 2) throw new Error(`unsupported snapshot schemaVersion for cache verification: ${String(snapshot.schemaVersion)}`);
  const unknownPhase = rows(snapshot, "compileCache").find((row) => !VERIFIED_CACHE_PHASES.has(String(row.phase)));
  if (unknownPhase !== undefined) throw new Error(`compile-cache phase ${String(unknownPhase.phase)} has no cache-key construction recipe`);

  const partitionRows = phaseRows(snapshot, "partition");
  if (partitionRows.length > 0) {
    const { targetTokens } = contractPart(snapshot, "partition");
    requireKeyMultiset("partition", partitionRows, [contentHash(
      ...rows(snapshot, "ideas").map((idea) => String(idea.idea_id)).sort(),
      `target=${String(targetTokens)}`,
    )]);
  }

  const synthesizeRows = phaseRows(snapshot, "synthesize");
  if (synthesizeRows.length > 0) {
    const contract = contractPart(snapshot, "synthesize");
    const partition = partitionRows[0]?.value as Row | undefined;
    const chunks = partition?.chunks as Json[][] | undefined;
    if (chunks === undefined) throw new Error("synthesize cache verification requires partition chunks");
    requireKeyMultiset("synthesize", synthesizeRows, chunks.map((chunk) => contentHash(
      ...chunk.map(String).sort(),
      `prompt=${String(contract.promptHash)}`,
      `model=${String(contract.model)}`,
    )));
  }

  const localTopicRows = premergedLocalTopics(snapshot).sort((left, right) => String(left.local_topic_id).localeCompare(String(right.local_topic_id)));
  const registryRows = phaseRows(snapshot, "canonicalize_registry");
  if (registryRows.length > 0) {
    const contract = contractPart(snapshot, "canonicalizeRegistry");
    const localSignatures = localTopicRows.map((topic) => contentHash(
      String(topic.title),
      String(topic.description),
      String((topic.subsumed_idea_ids as Json[]).length),
    ));
    requireKeyMultiset("canonicalize_registry", registryRows, [contentHash(
      ...localSignatures,
      `prompt=${String(contract.promptHash)}`,
      `hint=${contentHash(String(contract.thematicHint))}`,
      `model=${String(contract.model)}`,
    )]);
  }

  const assignRows = phaseRows(snapshot, "canonicalize_assign");
  if (assignRows.length > 0) {
    const contract = contractPart(snapshot, "canonicalizeAssign");
    const registryTopics = ((registryRows[0]?.value as Row | undefined)?.topics ?? []) as Row[];
    const registrySignature = contentHash(...registryTopics.map((topic) => `${String(topic.slug)}|${String(topic.title)}|${String(topic.description)}`));
    const batchSize = Number(contract.batchSize);
    if (!Number.isInteger(batchSize) || batchSize <= 0) throw new Error("canonicalizeAssign cache-key contract is missing batchSize");
    const batches = Array.from({ length: Math.ceil(localTopicRows.length / batchSize) }, (_, index) => localTopicRows.slice(index * batchSize, (index + 1) * batchSize));
    requireKeyMultiset("canonicalize_assign", assignRows, batches.map((batch) => contentHash(
      `registry=${registrySignature}`,
      ...batch.map((topic) => `${String(topic.local_topic_id)}:${contentHash(String(topic.title), String(topic.description))}`),
      `prompt=${String(contract.promptHash)}`,
      `model=${String(contract.model)}`,
    )));
  }

  const renderRows = phaseRows(snapshot, "render");
  if (renderRows.length > 0) {
    const contract = contractPart(snapshot, "render");
    const memberships = rows(snapshot, "memberships");
    const links = rows(snapshot, "topicLinks");
    const topicsById = new Map(rows(snapshot, "topics").map((topic) => [String(topic.topic_id), topic]));
    const renderable = rows(snapshot, "topics").filter((topic) => topic.article_status !== "archived");
    requireKeyMultiset("render", renderRows, renderable.map((topic) => {
      const topicId = String(topic.topic_id);
      const ideaIds = memberships.filter((membership) => membership.topic_id === topic.topic_id).map((membership) => String(membership.idea_id)).sort();
      const linkTargets = links.filter((link) => link.source_topic_id === topic.topic_id)
        .map((link) => String(topicsById.get(String(link.target_topic_id))?.slug))
        .sort();
      return contentHash(
        topicId,
        contentHash(String(topic.title), String(topic.description), ...ideaIds),
        ...linkTargets,
        `prompt=${String(contract.promptHash)}`,
        `model=${String(contract.model)}`,
      );
    }));
  }
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
    if (rest.phase === "synthesize") {
      // Which same-slug twin becomes the premerge representative is
      // completion-order dependent, so per-chunk local_topic_id values are
      // not stable identities; rows pair on chunk content alone while the
      // assign relation still validates representative ids.
      const value = rest.value as Row;
      rest.value = {
        ...value,
        local_topics: (value.local_topics as Row[]).map(
          ({ local_topic_id: _localTopicId, ...topic }) => topic,
        ),
      };
    }
    return JSON.stringify(rest);
  };
  const expectedIndex = indexUnique(rows(expected, "compileCache"), (row) => `${String(row.phase)}\0${withoutKey(row)}`, "golden cache row");
  const actualIndex = indexUnique(rows(actual, "compileCache"), (row) => `${String(row.phase)}\0${withoutKey(row)}`, "replay cache row");
  if (expectedIndex.size !== actualIndex.size) throw new Error(`compile-cache cardinality differs: ${expectedIndex.size} != ${actualIndex.size}`);
  for (const [stableKey, actualRow] of actualIndex) {
    const expectedRow = expectedIndex.get(stableKey);
    if (expectedRow === undefined) {
      const body = (actualRow.value as Row).body;
      const heading = typeof body === "string" ? body.split("\n", 1)[0] : undefined;
      const expectedWithHeading = actualRow.phase === "render" && heading !== undefined
        ? rows(expected, "compileCache").find((row) => row.phase === "render" && (row.value as Row).body !== undefined
          && String((row.value as Row).body).split("\n", 1)[0] === heading)
        : undefined;
      const detail = actualRow.phase === "render" && typeof body === "string"
        ? ` heading=${JSON.stringify(heading)} actualBodyHash=${createHash("sha256").update(body).digest("hex")} expectedBodyHash=${expectedWithHeading === undefined ? "missing" : createHash("sha256").update(String((expectedWithHeading.value as Row).body)).digest("hex")}`
        : "";
      throw new Error(`compile-cache row has no golden partner: ${String(actualRow.phase)}${detail}`);
    }
    if (actualRow.phase === "extract" && actualRow.cache_key !== expectedRow.cache_key) {
      throw new Error(`extract cache key differs verbatim for document ${String(((actualRow.value as Row).source_card as Row).document_id)}`);
    }
    actualRow.cache_key = expectedRow.cache_key;
    actualRow.sort_key = expectedRow.sort_key;
  }
};

// Which same-slug twin holds which local_topic_id is completion-order noise;
// the assign relation has already validated the ids, so the final comparison
// drops them from synthesize rows on both sides.
const scrubSynthesizeLocalIds = (snapshot: Row) => {
  snapshot.compileCache = rows(snapshot, "compileCache").map((row) => {
    if (row.phase !== "synthesize") return row;
    const value = row.value as Row;
    return {
      ...row,
      value: {
        ...value,
        local_topics: (value.local_topics as Row[]).map(
          ({ local_topic_id: _localTopicId, ...topic }) => topic,
        ),
      },
    };
  });
  return snapshot;
};

const sortNormalized = (value: Row) => {
  for (const field of ["compileCache", "ideas", "ideaAnchors", "memberships", "topicLinks", "topicRelated", "backlinks"] as const) {
    const list = value[field];
    if (Array.isArray(list)) list.sort((left, right) => stable(left).localeCompare(stable(right)));
  }
  return value;
};

const emptyMapping: Mapping = new Map();

const normalizeSnapshot = (expected: Row, actual: Row) => {
  verifyCacheKeyConstruction(expected);
  verifyCacheKeyConstruction(actual);
  const mapping = buildIdentityMapping(expected, actual);
  normalizeDerivedTopicHashes(expected, actual, mapping);
  normalizeFileHashes(expected, actual, mapping);
  // Substitute once, then adopt golden rows on the substituted structure.
  // Both runs mint from the same deterministic uuid pool, so a later
  // substitution pass would re-map ids inside already-adopted golden rows.
  const substituted = replace(actual, mapping) as Row;
  normalizeAssignmentBatches(expected, substituted, emptyMapping);
  normalizeCacheKeys(expected, substituted, emptyMapping);
  return sortNormalized(substituted);
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
  sortNormalized(scrubSynthesizeLocalIds(normalizedExpected));
  sortNormalized(scrubSynthesizeLocalIds(normalizedActual));
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
