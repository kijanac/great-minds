import { createHash, randomUUID } from "node:crypto";

import * as PgClient from "@effect/sql-pg/PgClient";
import {
  compileCacheEntries,
  Database,
  DatabaseLive as GreatMindsDatabaseLive,
} from "@great-minds/database";
import { eq, sql } from "drizzle-orm";
import { Effect, Layer, Redacted } from "effect";

import { requestBackend, type CapturedResponse } from "./http.ts";
import {
  asArray,
  asRecord,
  asString,
  baseUrl,
  encodeDocumentPath,
  refuseProdTarget,
  requiredEnv,
  responseRecord,
  sleep,
} from "./staging-common.ts";

const PAGE_SIZE = 200;
const POLL_INTERVAL_MS = 500;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000;

const tsUrl = baseUrl("STAGING_TS_BASE_URL");
const bearer = requiredEnv("STAGING_BEARER_TOKEN");
const vaultId = requiredEnv("STAGING_VAULT_ID");
const databaseUrl = refuseProdTarget(requiredEnv("DATABASE_URL"), "DATABASE_URL");
const timeoutMs = Number(process.env.STAGING_COMPILE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
  throw new Error("STAGING_COMPILE_TIMEOUT_MS must be a positive integer");
}

const DatabaseLive = GreatMindsDatabaseLive.pipe(
  Layer.provide(PgClient.layer({ url: Redacted.make(databaseUrl) })),
);

const runDb = <A>(effect: Effect.Effect<A, unknown, Database>) =>
  Effect.runPromise(effect.pipe(Effect.provide(DatabaseLive)));

const cacheCount = () =>
  runDb(
    Effect.gen(function* () {
      const db = yield* Database;
      const rows = yield* db
        .select({ count: sql<number>`count(*)::int` })
        .from(compileCacheEntries)
        .where(eq(compileCacheEntries.vaultId, vaultId))
        .pipe(Effect.orDie);
      const count = rows[0]?.count;
      if (count === undefined) throw new Error("compile cache count returned no row");
      return count;
    }),
  );

const read = (path: string) =>
  requestBackend(
    { name: "typescript", baseUrl: tsUrl },
    { id: path, label: path, method: "GET", path, bearer },
  );

const wikiItems = async () => {
  const items: unknown[] = [];
  let offset = 0;
  while (true) {
    const response = await read(`/v1/vaults/${vaultId}/wiki?limit=${PAGE_SIZE}&offset=${offset}`);
    const body = responseRecord(response, "wiki list");
    const page = asArray(body.items, "wiki list items");
    items.push(...page);
    const pagination = asRecord(body.pagination, "wiki pagination");
    if (typeof pagination.total !== "number") {
      throw new Error("wiki pagination total must be a number");
    }
    offset += page.length;
    if (offset >= pagination.total) return items;
    if (page.length === 0) throw new Error("wiki pagination stopped before total");
  }
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const artifactSnapshot = async () => {
  const snapshot = new Map<string, string>();
  for (const item of await wikiItems()) {
    const overview = asRecord(item, "wiki overview");
    const path = asString(overview.file_path, "wiki file_path");
    const response = await read(`/v1/vaults/${vaultId}/doc/${encodeDocumentPath(path)}`);
    const body = responseRecord(response, `document ${path}`);
    const article = asRecord(body.article, `document ${path} article`);
    const bodyHash = asString(article.body_hash, `document ${path} body_hash`);
    const markdown = asString(body.body, `document ${path} body`);
    snapshot.set(path, sha256(`${bodyHash}\0${markdown}`));
  }
  return snapshot;
};

const postCompile = async (): Promise<CapturedResponse> => {
  const response = await fetch(`${tsUrl}/v1/vaults/${vaultId}/compile`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ job_id: randomUUID() }),
  });
  const text = await response.text();
  const contentType = response.headers.get("content-type");
  return {
    status: response.status,
    contentType,
    body: text.length === 0 ? undefined : (JSON.parse(text) as unknown),
    text,
  };
};

const firstArtifactDiff = (
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
) => {
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const path of [...paths].sort()) {
    if (before.get(path) !== after.get(path)) {
      return { path, before: before.get(path) ?? null, after: after.get(path) ?? null };
    }
  }
  return undefined;
};

const startedAt = Date.now();
const beforeCacheCount = await cacheCount();
if (beforeCacheCount <= 0) {
  throw new Error(`vault ${vaultId} has no warm compile_cache_entries rows`);
}
const beforeArtifacts = await artifactSnapshot();
if (beforeArtifacts.size === 0) {
  throw new Error(`vault ${vaultId} has no rendered wiki artifacts to compare`);
}

const submitted = await postCompile();
if (submitted.status !== 202) {
  throw new Error(`POST /compile returned HTTP ${submitted.status}`);
}
const submittedJob = responseRecord(submitted, "compile submission");
const jobId = asString(submittedJob.id, "compile submission id");

let terminal: Record<string, unknown> | undefined;
while (Date.now() - startedAt < timeoutMs) {
  const response = await read(`/v1/vaults/${vaultId}/jobs/${jobId}`);
  const job = responseRecord(response, `job ${jobId}`);
  const status = asString(job.status, `job ${jobId} status`);
  if (status === "completed" || status === "failed" || status === "cancelled") {
    terminal = job;
    break;
  }
  await sleep(POLL_INTERVAL_MS);
}
if (terminal === undefined) {
  throw new Error(`compile ${jobId} did not reach terminal state within ${timeoutMs}ms`);
}
if (terminal.status !== "completed") {
  throw new Error(
    `compile ${jobId} ended ${String(terminal.status)}: ${String(terminal.error ?? "no error detail")}`,
  );
}

const afterArtifacts = await artifactSnapshot();
const artifactDiff = firstArtifactDiff(beforeArtifacts, afterArtifacts);
if (artifactDiff !== undefined) {
  throw new Error(`rendered artifact changed: ${JSON.stringify(artifactDiff)}`);
}
const afterCacheCount = await cacheCount();
if (afterCacheCount !== beforeCacheCount) {
  throw new Error(
    `compile cache row count changed: before=${beforeCacheCount} after=${afterCacheCount}`,
  );
}

console.log(
  JSON.stringify({
    status: "PASS",
    vault_id: vaultId,
    job_id: jobId,
    cache_entries: beforeCacheCount,
    artifact_count: beforeArtifacts.size,
    llm_proof: "compile completed while OPENROUTER_API_URL was configured to a dead port",
    duration_ms: Date.now() - startedAt,
  }),
);
