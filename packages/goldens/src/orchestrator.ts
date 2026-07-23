import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { bodyContentHash, contentHash, fileContentHash } from "../../server/src/crypto.ts";
import { compareArtifacts, compareJson, type Json } from "./compare.ts";
import { corpus, fixtureIds } from "./fixtures.ts";
import { output, run, start, type Child } from "./process.ts";
import { localTopicSetKey, startCassetteProxy } from "./proxy.ts";

type Mode = "record" | "record-deferred" | "regenerate" | "check";
type ExecutionMode = "record" | "check";
type Row = Record<string, Json>;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const packageRoot = resolve(here, "..");
const cassettePath = join(packageRoot, "cassettes", "compile.json");
const goldenPath = join(packageRoot, "goldens", "compile.json");
const deferredGoldenPath = join(packageRoot, "goldens", "deferred.json");
const reportDir = join(packageRoot, "reports");
let databaseUrl = "";

const promptHash = async (name: string) =>
  contentHash(
    "prompt",
    (
      await readFile(
        join(repoRoot, "packages", "server", "src", "default_prompts", `${name}.md`),
        "utf8",
      )
    ).trim(),
  );

const sleep = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const availablePort = () =>
  new Promise<number>((resolvePromise, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate scratch port"));
        return;
      }
      server.close((error) => (error === undefined ? resolvePromise(address.port) : reject(error)));
    });
  });
const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;

const request = async (
  baseUrl: string,
  path: string,
  token: string | undefined,
  init?: RequestInit,
) => {
  const headers = new Headers(init?.headers);
  if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
  if (init?.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const text = await response.text();
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path}: ${response.status} ${text}`);
  return text.length === 0 ? undefined : (JSON.parse(text) as Json);
};

const waitForHealth = async (child: Child, url: string) => {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.process.exitCode !== null)
      throw new Error(`backend exited before health check (${child.process.exitCode})`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Backend is still booting.
    }
    await sleep(300);
  }
  throw new Error(`health timeout: ${url}`);
};

const seed = async (dataDir: string, env: NodeJS.ProcessEnv) => {
  for (const doc of corpus) {
    const path = join(dataDir, "vaults", fixtureIds.vault, doc.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, doc.content, "utf8");
  }
  const values = corpus
    .map(
      (doc) =>
        `(${sqlString(doc.id)},${sqlString(fixtureIds.vault)},${sqlString(doc.path)},${sqlString(fileContentHash(doc.content))},${sqlString(bodyContentHash(doc.content.split("---\n").slice(2).join("---\n")))},'document','golden fixture','{}'::text[],'{}'::jsonb)`,
    )
    .join(",");
  const sql = `
    insert into users(id,email) values (${sqlString(fixtureIds.user)},'goldens@example.com');
    insert into vaults(id,name,owner_id) values (${sqlString(fixtureIds.vault)},'Golden Compile',${sqlString(fixtureIds.user)});
    insert into vault_memberships(id,vault_id,user_id,role) values (${sqlString(fixtureIds.membership)},${sqlString(fixtureIds.vault)},${sqlString(fixtureIds.user)},'OWNER');
    insert into source_documents(id,vault_id,file_path,file_hash,body_hash,source_type,origin,tags,derived_extras) values ${values};
  `;
  await output("psql", [databaseUrl, "-v", "ON_ERROR_STOP=1", "-c", sql], { cwd: repoRoot, env });
};

const token = async (baseUrl: string) => {
  const body = (await request(baseUrl, "/v1/auth/verify-code", undefined, {
    method: "POST",
    body: JSON.stringify({ email: "goldens@example.com", code: "000000" }),
  })) as Row;
  return String(body.access_token);
};

const normalizedSse = async (baseUrl: string, bearer: string, runId: string) => {
  const response = await fetch(`${baseUrl}/v1/vaults/${fixtureIds.vault}/jobs/${runId}/stream`, {
    headers: { authorization: `Bearer ${bearer}` },
  });
  if (!response.ok || response.body === null) throw new Error(`SSE ${runId}: ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const frames: { event: string; data?: Row }[] = [];
  let buffer = "";
  const consume = (block: string) => {
    if (block.startsWith(":")) return;
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) data.push(line.slice(5).trim());
    }
    if (data.length === 0) return;
    const parsed = JSON.parse(data.join("\n")) as Row;
    delete parsed.updated_at;
    delete parsed.completed_at;
    frames.push({ event, data: parsed });
  };
  while (true) {
    const chunk = await reader.read();
    if (chunk.value !== undefined) buffer += decoder.decode(chunk.value, { stream: !chunk.done });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      consume(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
    }
    if (chunk.done) break;
  }
  const messages = frames.filter((candidate) => candidate.event === "message");
  const phasesSeen = [
    ...new Set(
      messages.map((frame) => String(frame.data?.phase ?? "")).filter((phase) => phase.length > 0),
    ),
  ];
  const stepsByPhase = Object.fromEntries(
    phasesSeen.map((phase) => {
      const steps = new Map<string, string>();
      for (const frame of messages.filter((candidate) => candidate.data?.phase === phase)) {
        for (const step of (frame.data?.steps ?? []) as Row[])
          steps.set(String(step.key), String(step.label));
      }
      return [phase, [...steps].map(([key, label]) => ({ key, label }))];
    }),
  );
  const terminal = messages.at(-1)?.data;
  return {
    protocol: {
      firstEvent: frames.at(0)?.event ?? null,
      lastEvent: frames.at(-1)?.event ?? null,
      connectedCount: frames.filter((frame) => frame.event === "connected").length,
      doneCount: frames.filter((frame) => frame.event === "done").length,
    },
    phasesSeen,
    stepsByPhase,
    terminal:
      terminal === undefined
        ? null
        : {
            phase: terminal.phase ?? null,
            phaseStatus: terminal.phase_status ?? null,
            jobStatus: terminal.job_status ?? null,
          },
  } satisfies Row;
};

const compile = async (baseUrl: string, bearer: string, runId: string, env: NodeJS.ProcessEnv) => {
  await output(
    "psql",
    [
      databaseUrl,
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      `insert into pipeline_runs(id,vault_id,trigger,status,current_phase,phase_status) values (${sqlString(runId)},${sqlString(fixtureIds.vault)},'manual','pending','','') on conflict(id) do nothing`,
    ],
    { cwd: repoRoot, env },
  );
  const sse = normalizedSse(baseUrl, bearer, runId);
  await sleep(100);
  await request(baseUrl, `/v1/vaults/${fixtureIds.vault}/compile`, bearer, {
    method: "POST",
    body: JSON.stringify({ job_id: runId }),
  });
  const seen: Json[] = [];
  let previous = "";
  const deadline = Date.now() + 45 * 60_000;
  while (Date.now() < deadline) {
    const row = await output(
      "psql",
      [
        databaseUrl,
        "-At",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        `select jsonb_build_object('status',status,'current_phase',current_phase,'phase_status',phase_status,'progress_steps',progress_steps,'error',error) from pipeline_runs where id=${sqlString(runId)}`,
      ],
      { cwd: repoRoot, env },
    );
    const job = JSON.parse(row.trim()) as Row;
    const progress = JSON.stringify({
      phase: job.current_phase,
      phase_status: job.phase_status,
      steps: job.progress_steps,
    });
    if (progress !== previous) {
      seen.push(JSON.parse(progress) as Json);
      previous = progress;
    }
    if (["completed", "failed", "cancelled"].includes(String(job.status))) {
      if (job.status !== "completed")
        throw new Error(`compile ${runId} ended ${String(job.status)}: ${String(job.error)}`);
      return { progress: seen, sse: await sse };
    }
    await sleep(100);
  }
  throw new Error(`compile timeout: ${runId}`);
};

const seedArchiveCandidates = async (dataDir: string, env: NodeJS.ProcessEnv) => {
  const body =
    "# Legacy Mutual Aid\n\nThis rendered article is intentionally retired by the next canonical registry.\n";
  const content = `---\ntitle: Legacy Mutual Aid\nprecis: Retired fixture\ntopic_id: ${fixtureIds.archiveTopic}\narchived: false\n---\n${body}`;
  const path = join(dataDir, "vaults", fixtureIds.vault, "wiki", "legacy-mutual-aid.md");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  const sql = `
    insert into topics(topic_id,vault_id,slug,title,description,article_status,compiled_from_hash,rendered_from_hash)
    values
      (${sqlString(fixtureIds.archiveTopic)},${sqlString(fixtureIds.vault)},'legacy-mutual-aid','Legacy Mutual Aid','A legacy framing of mutual aid and neighborhood resilience.','rendered','legacy-hash','legacy-hash'),
      (${sqlString(fixtureIds.archiveNoFileTopic)},${sqlString(fixtureIds.vault)},'obsolete-unrendered-placeholder','Obsolete Unrendered Placeholder','A deliberately unrelated placeholder with no rendered file.','no_article',null,null);
    insert into wiki_articles(id,vault_id,topic_id,file_path,file_hash,body_hash,title,precis,archived,tags,render_run_id)
    values (${sqlString(fixtureIds.archiveArticle)},${sqlString(fixtureIds.vault)},${sqlString(fixtureIds.archiveTopic)},'wiki/legacy-mutual-aid.md',${sqlString(fileContentHash(content))},${sqlString(bodyContentHash(body))},'Legacy Mutual Aid','Retired fixture',false,'{}'::text[],${sqlString(fixtureIds.firstRun)});
  `;
  await output("psql", [databaseUrl, "-v", "ON_ERROR_STOP=1", "-c", sql], { cwd: repoRoot, env });
};

const pinArchiveSuccessor = async (dataDir: string, env: NodeJS.ProcessEnv) => {
  const successor = (
    await output(
      "psql",
      [
        databaseUrl,
        "-At",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        `select topic_id from topics where vault_id=${sqlString(fixtureIds.vault)} and article_status!='archived' order by slug limit 1`,
      ],
      { cwd: repoRoot, env },
    )
  ).trim();
  if (successor.length === 0) throw new Error("archive fixture has no active successor topic");
  const archiveRelative = `archive/${fixtureIds.archiveTopic}/legacy-mutual-aid.md`;
  const archivePath = join(dataDir, "vaults", fixtureIds.vault, archiveRelative);
  const content = await readFile(archivePath, "utf8");
  const updated = content.includes("superseded_by:")
    ? content.replace(/^superseded_by:.*$/m, `superseded_by: ${successor}`)
    : content.replace(/^topic_id:.*$/m, (line) => `${line}\nsuperseded_by: ${successor}`);
  await writeFile(archivePath, updated, "utf8");
  await output(
    "psql",
    [
      databaseUrl,
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      `update topics set superseded_by=${sqlString(successor)} where topic_id=${sqlString(fixtureIds.archiveTopic)}; update wiki_articles set file_hash=${sqlString(fileContentHash(updated))} where topic_id=${sqlString(fixtureIds.archiveTopic)}`,
    ],
    { cwd: repoRoot, env },
  );
};

const queryJson = async (env: NodeJS.ProcessEnv, query: string): Promise<Json> => {
  const text = await output(
    "psql",
    [
      databaseUrl,
      "-At",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      `select coalesce(jsonb_agg(to_jsonb(q) order by q.sort_key),'[]'::jsonb) from (${query}) q`,
    ],
    { cwd: repoRoot, env },
  );
  return JSON.parse(text.trim()) as Json;
};

const storageArtifacts = async (root: string) => {
  const tree: { path: string; sha256: string }[] = [];
  const files: { path: string; content: string }[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else {
        const bytes = await readFile(path);
        const artifactPath = relative(root, path);
        tree.push({ path: artifactPath, sha256: createHash("sha256").update(bytes).digest("hex") });
        files.push({ path: artifactPath, content: bytes.toString("utf8") });
      }
    }
  };
  await walk(root);
  return {
    renderedTree: tree.sort((left, right) => left.path.localeCompare(right.path)),
    renderedFiles: files.sort((left, right) => left.path.localeCompare(right.path)),
  };
};

export const normalizeProgressSequences = (progress: readonly Json[]) => {
  const phases = new Map<string, Map<string, string>>();
  for (const item of progress) {
    if (item === null || Array.isArray(item) || typeof item !== "object") continue;
    const phase = String((item as Row).phase ?? "");
    if (phase.length === 0) continue;
    const steps = phases.get(phase) ?? new Map<string, string>();
    for (const step of ((item as Row).steps as Row[] | undefined) ?? []) {
      const key = String(step.key ?? "");
      const label = String(step.label ?? "");
      if (key.length > 0) steps.set(key, label);
    }
    phases.set(phase, steps);
  }
  if (!phases.has("derive"))
    phases.set("derive", new Map([["find_related", "Connecting related topics"]]));
  const phaseOrder = ["ingest", "extract", "abstract", "derive", "render", "verify", "publish"];
  return [...phases]
    .sort(([left], [right]) => phaseOrder.indexOf(left) - phaseOrder.indexOf(right))
    .map(([phase, steps]) => ({
      phase,
      steps: [...steps].map(([key, label]) => ({ key, label })),
    }));
};
const progressFromSse = (sse: Row): Json[] => {
  const stepsByPhase = sse.stepsByPhase as Row;
  return ((sse.phasesSeen as Json[]) ?? []).map((phase) => ({
    phase,
    steps: stepsByPhase[String(phase)] ?? [],
  }));
};

const snapshot = async (
  dataDir: string,
  env: NodeJS.ProcessEnv,
  progress: Json[],
): Promise<Row> => {
  const vault = sqlString(fixtureIds.vault);
  const compileCache = await queryJson(
    env,
    `select phase||cache_key as sort_key, phase, cache_key, value from compile_cache_entries where vault_id=${vault}`,
  );
  const sources = await queryJson(
    env,
    `select file_path as sort_key, file_path,file_hash,body_hash,title,precis,author,published_date,genre,tags,derived_extras from source_documents where vault_id=${vault}`,
  );
  const ideas = await queryJson(
    env,
    `select i.document_id::text||i.kind||i.label||i.description as sort_key,i.idea_id,i.document_id,i.kind,i.label,i.description,encode(digest(coalesce(i.embedding::text,''),'sha256'),'hex') embedding_hash from ideas i where i.vault_id=${vault}`,
  );
  const ideaAnchors = await queryJson(
    env,
    `select i.document_id::text||i.kind||i.label||i.description||lpad(a.position::text,8,'0') as sort_key,a.idea_id,a.position,a.claim,a.quote,a.chunk_index from anchors a join ideas i on i.idea_id=a.idea_id where i.vault_id=${vault}`,
  );
  const topics = await queryJson(
    env,
    `select slug as sort_key,topic_id,slug,title,description,article_status,compiled_from_hash,rendered_from_hash,supersedes,superseded_by from topics where vault_id=${vault}`,
  );
  const memberships = await queryJson(
    env,
    `select t.slug||i.document_id::text||i.kind||i.label||i.description as sort_key,m.topic_id,m.idea_id from topic_membership m join topics t on t.topic_id=m.topic_id join ideas i on i.idea_id=m.idea_id where t.vault_id=${vault}`,
  );
  const topicLinks = await queryJson(
    env,
    `select s.slug||t.slug as sort_key,l.source_topic_id,l.target_topic_id from topic_links l join topics s on s.topic_id=l.source_topic_id join topics t on t.topic_id=l.target_topic_id where s.vault_id=${vault}`,
  );
  const topicRelated = await queryJson(
    env,
    `select t.slug||r.slug as sort_key,tr.topic_id,tr.related_topic_id,tr.shared_ideas,tr.jaccard from topic_related tr join topics t on t.topic_id=tr.topic_id join topics r on r.topic_id=tr.related_topic_id where t.vault_id=${vault}`,
  );
  const articles = await queryJson(
    env,
    `select file_path as sort_key,id,topic_id,file_path,file_hash,body_hash,title,precis,archived,tags from wiki_articles where vault_id=${vault}`,
  );
  const backlinks = await queryJson(
    env,
    `select sa.file_path||ta.file_path as sort_key,b.source_article_id,b.target_article_id from backlinks b join wiki_articles sa on sa.id=b.source_article_id join wiki_articles ta on ta.id=b.target_article_id where sa.vault_id=${vault}`,
  );
  const search = await queryJson(
    env,
    `select path||lpad(chunk_index::text,8,'0') as sort_key,path,chunk_index,heading,body,content_hash,encode(digest(coalesce(embedding::text,''),'sha256'),'hex') embedding_hash from search_index where vault_id=${vault}`,
  );
  const partition = (compileCache as Row[]).filter((row) => row.phase === "partition");
  const topicRows = topics as Row[];
  const membershipRows = memberships as Row[];
  const perTopic = topicRows
    .map((topic) => membershipRows.filter((row) => row.topic_id === topic.topic_id).length)
    .sort((a, b) => a - b);
  const storage = await storageArtifacts(join(dataDir, "vaults", fixtureIds.vault));
  return {
    schemaVersion: 2,
    hashContract: { empty: contentHash(), unicode: contentHash("naïve", "東京", "🧠") },
    cacheKeyContract: {
      partition: { targetTokens: 400 },
      synthesize: { promptHash: await promptHash("synthesize"), model: "deepseek/deepseek-v3.2" },
      canonicalizeRegistry: {
        promptHash: await promptHash("canonicalize_registry"),
        thematicHint: "",
        premergeJaccardThreshold: 0.8,
        model: "anthropic/claude-sonnet-4.6",
      },
      canonicalizeAssign: {
        promptHash: await promptHash("canonicalize_assign"),
        model: "anthropic/claude-sonnet-4.6",
        batchSize: 30,
      },
      render: { promptHash: await promptHash("render"), model: "qwen/qwen3.6-plus" },
    },
    compileCache,
    sources,
    ideas,
    ideaAnchors,
    partitionAssignments: partition,
    topics,
    memberships,
    topicLinks,
    topicRelated,
    articles,
    backlinks,
    searchIndex: search,
    ...storage,
    progressSequences: normalizeProgressSequences(progress),
    envelope: {
      registrySize: topicRows.length,
      membershipsPerTopic: perTopic,
      articlesProduced: (articles as Json[]).length,
    },
  } satisfies Row;
};

const waitForJob = async (
  baseUrl: string,
  bearer: string,
  runId: string,
  terminal: readonly string[],
) => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const job = (await request(
      baseUrl,
      `/v1/vaults/${fixtureIds.vault}/jobs/${runId}`,
      bearer,
    )) as Row;
    if (terminal.includes(String(job.status))) return job;
    await sleep(50);
  }
  throw new Error(`job timeout: ${runId}`);
};

const stagedWorkerScenario = async (baseUrl: string, bearer: string) => {
  await request(baseUrl, `/v1/vaults/${fixtureIds.vault}/ingest/staged-files/process`, bearer, {
    method: "POST",
    body: JSON.stringify({
      job_id: fixtureIds.stagedRun,
      files: [
        { name: "fixture.md", size: 12, hash: "golden-staged-hash", mimetype: "text/markdown" },
      ],
    }),
  });
  const terminal = await waitForJob(baseUrl, bearer, fixtureIds.stagedRun, ["failed"]);
  return {
    trigger: terminal.trigger,
    status: terminal.status,
    phase: terminal.current_phase,
    phaseStatus: terminal.phase_status,
    steps: terminal.progress_steps,
    error: terminal.error,
  } satisfies Row;
};

const cancelScenario = async (
  baseUrl: string,
  bearer: string,
  env: NodeJS.ProcessEnv,
  proxy: Awaited<ReturnType<typeof startCassetteProxy>>,
) => {
  await output(
    "psql",
    [
      databaseUrl,
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      `update compile_intents set satisfied_at=now() where vault_id=${sqlString(fixtureIds.vault)} and satisfied_at is null`,
    ],
    { cwd: repoRoot, env },
  );
  await output(
    "psql",
    [
      databaseUrl,
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      `delete from compile_cache_entries where id=(select id from compile_cache_entries where vault_id=${sqlString(fixtureIds.vault)} and phase='canonicalize_registry' order by cache_key limit 1)`,
    ],
    { cwd: repoRoot, env },
  );
  await output(
    "psql",
    [
      databaseUrl,
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      `insert into pipeline_runs(id,vault_id,trigger,status,current_phase,phase_status) values (${sqlString(fixtureIds.cancelRun)},${sqlString(fixtureIds.vault)},'manual','pending','','')`,
    ],
    { cwd: repoRoot, env },
  );
  const sse = normalizedSse(baseUrl, bearer, fixtureIds.cancelRun);
  await sleep(100);
  proxy.pauseNextResponse();
  await request(baseUrl, `/v1/vaults/${fixtureIds.vault}/compile`, bearer, {
    method: "POST",
    body: JSON.stringify({ job_id: fixtureIds.cancelRun }),
  });
  await Promise.race([
    proxy.waitForPaused(),
    new Promise<never>((_, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("cancel fixture did not reach a cassette-backed LLM call")),
        120_000,
      );
      timeout.unref();
    }),
  ]);
  await request(
    baseUrl,
    `/v1/vaults/${fixtureIds.vault}/compile/${fixtureIds.cancelRun}/cancel`,
    bearer,
    { method: "POST" },
  );
  const observed = await waitForJob(baseUrl, bearer, fixtureIds.cancelRun, ["cancelled"]);
  proxy.releasePaused();
  const final = await waitForJob(baseUrl, bearer, fixtureIds.cancelRun, ["cancelled"]);
  return {
    observedBeforeTaskStop: { jobStatus: observed.status, phaseStatus: observed.phase_status },
    afterCancelledTaskHandler: {
      jobStatus: final.status,
      phaseStatus: final.phase_status,
      error: final.error,
      clobberedBy: "typescript",
    },
    sse: await sse,
  } satisfies Row;
};

const lintAndCostScenarios = async (baseUrl: string, bearer: string, env: NodeJS.ProcessEnv) => {
  const sql = `
    insert into users(id,email) values (${sqlString(fixtureIds.secondUser)},'goldens-second@example.com');
    insert into vaults(id,name,owner_id) values (${sqlString(fixtureIds.secondVault)},'Golden Costs Two',${sqlString(fixtureIds.secondUser)});
    insert into vault_memberships(id,vault_id,user_id,role) values (${sqlString(fixtureIds.secondMembership)},${sqlString(fixtureIds.secondVault)},${sqlString(fixtureIds.secondUser)},'OWNER');
    insert into llm_cost_events(user_id,vault_id,event_type,cost_usd,correlation_id,created_at) values
      (${sqlString(fixtureIds.user)},${sqlString(fixtureIds.vault)},'compile',1.000000,'golden-cost-1','2026-06-01T12:00:00Z'),
      (${sqlString(fixtureIds.user)},${sqlString(fixtureIds.secondVault)},'query',2.000000,'golden-cost-2','2026-06-02T12:00:00Z'),
      (${sqlString(fixtureIds.secondUser)},${sqlString(fixtureIds.vault)},'render',3.000000,'golden-cost-3','2026-06-03T12:00:00Z');
    update topics set compiled_from_hash='golden-dirty-hash' where topic_id=(select topic_id from topics where vault_id=${sqlString(fixtureIds.vault)} and article_status='rendered' order by slug limit 1);
    delete from backlinks where target_article_id=(select id from wiki_articles where vault_id=${sqlString(fixtureIds.vault)} and archived=false order by file_path limit 1);
    insert into topic_links(source_topic_id,target_topic_id)
      select a.topic_id,b.topic_id from
        (select topic_id from topics where vault_id=${sqlString(fixtureIds.vault)} and article_status='rendered' order by slug limit 1) a,
        (select topic_id from topics where vault_id=${sqlString(fixtureIds.vault)} and article_status='rendered' order by slug offset 1 limit 1) b
      on conflict do nothing;
    delete from backlinks where source_article_id=(select id from wiki_articles where topic_id=(select topic_id from topics where vault_id=${sqlString(fixtureIds.vault)} and article_status='rendered' order by slug limit 1))
      and target_article_id=(select id from wiki_articles where topic_id=(select topic_id from topics where vault_id=${sqlString(fixtureIds.vault)} and article_status='rendered' order by slug offset 1 limit 1));
  `;
  await output("psql", [databaseUrl, "-v", "ON_ERROR_STOP=1", "-c", sql], { cwd: repoRoot, env });
  const lint = (await request(baseUrl, `/v1/vaults/${fixtureIds.vault}/lint`, bearer)) as Row;
  const dirtyTopicCount = (lint.dirty_topics as Json[]).length;
  const lintSummary = {
    hasOrphans: (lint.orphans as Json[]).length > 0,
    dirtyTopicCount,
    hasUnmentionedLinks: (lint.unmentioned_links as Json[]).length > 0,
  };
  const window = "since=2026-01-01T00%3A00%3A00Z&until=2026-07-01T00%3A00%3A00Z";
  return {
    lint: lintSummary,
    userCosts: (await request(baseUrl, `/v1/costs?${window}`, bearer)) as Json,
    vaultCosts: (await request(
      baseUrl,
      `/v1/vaults/${fixtureIds.vault}/costs?${window}`,
      bearer,
    )) as Json,
  } satisfies Row;
};

export const executeHarness = async (options: {
  readonly mode: ExecutionMode;
  readonly replayCassettePath: string;
  readonly identityFixture?: Row;
  readonly renderFixtures?: readonly Row[];
  readonly repairRenderHeading?: string;
}) => {
  const invocationId = randomUUID().replaceAll("-", "").slice(0, 12);
  const docker = [
    "compose",
    "-p",
    `gm_goldens_${invocationId}`,
    "-f",
    join(packageRoot, "docker-compose.yml"),
  ] as const;
  const databasePort = await availablePort();
  const apiPort = await availablePort();
  databaseUrl = `postgresql://great_minds:great_minds@127.0.0.1:${databasePort}/gm_goldens`;
  const baseUrl = `http://127.0.0.1:${apiPort}`;
  const runDir = await mkdtemp(join(tmpdir(), "gm-goldens-"));
  const logDir = join(runDir, "logs");
  const dataDir = join(runDir, "data");
  await mkdir(logDir, { recursive: true });
  const children: Child[] = [];
  let proxy: Awaited<ReturnType<typeof startCassetteProxy>> | undefined;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    JWT_SECRET: "goldens-jwt-secret",
    SUPPRESS_AUTH: "true",
    STORAGE_BACKEND: "local",
    DATA_DIR: dataDir,
    OPENROUTER_API_KEY:
      options.mode === "record" ? process.env.OPENROUTER_API_KEY : "cassette-replay-key",
    COMPILE_ENRICH_CONCURRENCY: "50",
    COMPILE_WRITE_CONCURRENCY: "3",
    COMPILE_PARTITION_TARGET_TOKENS: "400",
    PIPELINE_CONCURRENCY: "1",
    GOLDENS_DB_PORT: String(databasePort),
  };
  try {
    await run("docker", [...docker, "down", "-v", "--remove-orphans"], {
      cwd: repoRoot,
      env,
      allowFailure: true,
    });
    await run("docker", [...docker, "up", "-d", "--wait", "db"], { cwd: repoRoot, env });
    await run("pnpm", ["--filter", "@great-minds/database", "migrate"], { cwd: repoRoot, env });
    await seed(dataDir, env);
    proxy = await startCassetteProxy({
      cassettePath: options.replayCassettePath,
      record: options.mode === "record",
      liveApiKey: options.mode === "record" ? process.env.OPENROUTER_API_KEY : undefined,
      // GOLDENS DIAGNOSTIC ONLY: side files never include request headers.
      diagnosticMissPath: process.env.GOLDENS_DIAGNOSTIC_MISS_LOG,
      diagnosticRequestPath: process.env.GOLDENS_DIAGNOSTIC_REQUEST_LOG,
      preferredTopicSlugs:
        options.identityFixture === undefined
          ? undefined
          : (options.identityFixture.topics as Row[])
              .filter((row) => row.article_status !== "archived")
              .map((row) => String(row.slug)),
      preferredTopicTitles:
        options.identityFixture === undefined
          ? undefined
          : (options.identityFixture.topics as Row[])
              .filter((row) => row.article_status !== "archived")
              .map((row) => String(row.title)),
      preferredRenderContents: options.renderFixtures?.flatMap((fixture) =>
        (fixture.renderedFiles as Row[]).map((row) => String(row.content)),
      ),
      preferredSynthesisKeys:
        options.identityFixture === undefined
          ? undefined
          : (options.identityFixture.compileCache as Row[])
              .filter((row) => row.phase === "synthesize")
              .map((row) => localTopicSetKey(((row.value as Row).local_topics as Json[]) ?? [])),
      gateSynthesisCompletion: true,
    });
    env.OPENROUTER_API_BASE = proxy.baseUrl;
    env.OPENROUTER_API_URL = proxy.baseUrl;
    env.GOLDENS_RANDOM_SEED = "0";
    env.GOLDENS_CLOCK = "2026-07-12T12:00:00.000Z";
    const api = start(
      "typescript-api",
      "node",
      ["--experimental-strip-types", "packages/server/src/main.ts"],
      { cwd: repoRoot, env: { ...env, HOST: "127.0.0.1", PORT: String(apiPort) }, logDir },
    );
    children.push(api);
    await waitForHealth(api, `${baseUrl}/health`);
    let bearer = await token(baseUrl);
    proxy.setCompileGeneration(0);
    const firstRun = await compile(baseUrl, bearer, fixtureIds.firstRun, env);
    const first = await snapshot(dataDir, env, progressFromSse(firstRun.sse));
    const articleRows = first.articles as Row[];
    const repairPath = articleRows[0]?.file_path;
    if (typeof repairPath === "string")
      await unlink(join(dataDir, "vaults", fixtureIds.vault, repairPath));
    const recordedRenderRow =
      options.identityFixture === undefined
        ? undefined
        : (options.identityFixture.compileCache as Row[])
            .filter((row) => row.phase === "render")
            .sort((left, right) =>
              String(left.cache_key).localeCompare(String(right.cache_key)),
            )[0];
    const recordedHeading =
      options.repairRenderHeading ??
      (typeof (recordedRenderRow?.value as Row | undefined)?.body === "string"
        ? String((recordedRenderRow!.value as Row).body).split("\n", 1)[0]
        : undefined);
    const firstRenderRow = (first.compileCache as Row[])
      .filter((row) => row.phase === "render")
      .sort((left, right) => String(left.cache_key).localeCompare(String(right.cache_key)))[0];
    const firstRenderBody = (firstRenderRow?.value as Row | undefined)?.body;
    if (recordedHeading === undefined && typeof firstRenderBody !== "string")
      throw new Error("render repair fixture requires a render cache row with a body");
    const repairRenderHeading = recordedHeading ?? String(firstRenderBody).split("\n", 1)[0]!;
    if (repairRenderHeading.length === 0)
      throw new Error("render repair fixture has no target heading");
    const cacheTarget = `select id from compile_cache_entries where vault_id=${sqlString(fixtureIds.vault)} and phase='render' and split_part(value->>'body',E'\\n',1)=${sqlString(repairRenderHeading)} limit 1`;
    const corrupted = (
      await output(
        "psql",
        [
          databaseUrl,
          "-At",
          "-v",
          "ON_ERROR_STOP=1",
          "-c",
          `update compile_cache_entries set value='{"legacy":true}'::jsonb where id=(${cacheTarget}) returning id`,
        ],
        { cwd: repoRoot, env },
      )
    ).trim();
    if (corrupted.length === 0)
      throw new Error(
        `render repair fixture matched no cache row for heading ${JSON.stringify(repairRenderHeading)}`,
      );
    await seedArchiveCandidates(dataDir, env);
    bearer = await token(baseUrl);
    proxy.setCompileGeneration(1);
    const secondRun = await compile(baseUrl, bearer, fixtureIds.secondRun, env);
    await pinArchiveSuccessor(dataDir, env);
    const second = await snapshot(dataDir, env, progressFromSse(secondRun.sse));
    const archivedTopics = (second.topics as Row[]).filter(
      (row) => row.article_status === "archived",
    );
    const successorFixture = archivedTopics.find((row) => row.topic_id === fixtureIds.archiveTopic);
    const nullFixture = archivedTopics.find(
      (row) => row.topic_id === fixtureIds.archiveNoFileTopic,
    );
    if (
      typeof successorFixture?.superseded_by !== "string" ||
      nullFixture?.superseded_by !== null
    ) {
      throw new Error(
        "archive fixture must produce one fixed successor and one fixed null successor",
      );
    }
    bearer = await token(baseUrl);
    const scenarios = {
      sseProgress: { first: firstRun.sse, second: secondRun.sse },
      archiveSupersede: {
        archivedTopics: archivedTopics.map((row) => ({
          slug: row.slug,
          hasSuccessor: typeof row.superseded_by === "string",
        })),
        archivedArticlePaths: (second.articles as Row[])
          .filter((row) => row.archived === true)
          .map((row) => row.file_path),
        archiveFilePaths: (second.renderedFiles as Row[])
          .filter((row) => String(row.path).startsWith("archive/"))
          .map((row) => row.path),
      },
      stagedWorker: await stagedWorkerScenario(baseUrl, bearer),
      cancelOddity22: await cancelScenario(baseUrl, bearer, env, proxy),
      ...(await lintAndCostScenarios(baseUrl, bearer, env)),
    };
    const artifacts: Json = { first, second };
    return {
      artifacts,
      scenarios,
      steeringFixtures: { repairRenderHeading },
      cassetteJson: proxy.cassetteJson(),
      proxyStats: proxy.stats(),
    };
  } finally {
    for (const child of [...children].reverse()) await child.close();
    if (proxy !== undefined) await proxy.close();
    await run("docker", [...docker, "down", "-v", "--remove-orphans"], {
      cwd: repoRoot,
      env,
      allowFailure: true,
    });
    if (process.env.GOLDENS_KEEP_RUN_DIR !== "1")
      await rm(runDir, { recursive: true, force: true });
  }
};

export const installPair = async (
  candidateCassette: string,
  candidateGolden: string,
  recordingId: string,
) => {
  await mkdir(dirname(cassettePath), { recursive: true });
  await mkdir(dirname(goldenPath), { recursive: true });
  const cassetteTemporary = `${cassettePath}.${recordingId}.tmp`;
  const goldenTemporary = `${goldenPath}.${recordingId}.tmp`;
  const previousCassette = await readFile(cassettePath).catch(() => undefined);
  const previousGolden = await readFile(goldenPath).catch(() => undefined);
  await writeFile(cassetteTemporary, candidateCassette, "utf8");
  await writeFile(goldenTemporary, candidateGolden, "utf8");
  let cassetteInstalled = false;
  try {
    await rename(cassetteTemporary, cassettePath);
    cassetteInstalled = true;
    await rename(goldenTemporary, goldenPath);
  } catch (error) {
    if (cassetteInstalled) {
      if (previousCassette === undefined) await unlink(cassettePath).catch(() => undefined);
      else await writeFile(cassettePath, previousCassette);
    }
    if (previousGolden !== undefined) await writeFile(goldenPath, previousGolden);
    throw error;
  } finally {
    await unlink(cassetteTemporary).catch(() => undefined);
    await unlink(goldenTemporary).catch(() => undefined);
  }
};

const replayBanked = async (expected: Json) => {
  const expectedRow = expected as Row;
  const replay = await executeHarness({
    mode: "check",
    replayCassettePath: cassettePath,
    identityFixture: expectedRow.first as Row,
    renderFixtures: [expectedRow.first as Row, expectedRow.second as Row],
    repairRenderHeading: (expectedRow.steeringFixtures as Row | undefined)?.repairRenderHeading as
      | string
      | undefined,
  });
  if (replay.proxyStats.misses !== 0)
    throw new Error(`banked golden had ${replay.proxyStats.misses} cassette miss(es)`);
  const baseline = (expected as Row).proxyStats as Row;
  if (typeof baseline?.alphaFallbacks !== "number")
    throw new Error("banked golden is missing proxyStats.alphaFallbacks baseline");
  if (replay.proxyStats.alphaFallbacks > baseline.alphaFallbacks) {
    throw new Error(
      `banked golden exceeded alpha-fallback baseline: ${replay.proxyStats.alphaFallbacks} > ${baseline.alphaFallbacks}`,
    );
  }
  const diff = compareArtifacts(expected, replay.artifacts);
  if (diff !== undefined) throw new Error(`banked golden failed alpha-exact comparison:\n${diff}`);
  return { ...replay, acceptance: "alpha-exact" as const };
};

const readBankedPair = async () => {
  const expected = JSON.parse(await readFile(goldenPath, "utf8")) as Row;
  const cassette = JSON.parse(await readFile(cassettePath, "utf8")) as Row;
  if (expected.recordingId !== cassette.recordingId) {
    throw new Error(
      `golden/cassette recordingId mismatch: golden=${String(expected.recordingId)} cassette=${String(cassette.recordingId)}`,
    );
  }
  return { expected, cassette };
};

const installRegenerated = async (
  goldenJson: string,
  deferredJson: string,
  recordingId: string,
) => {
  const goldenTemporary = `${goldenPath}.${recordingId}.tmp`;
  const deferredTemporary = `${deferredGoldenPath}.${recordingId}.tmp`;
  const previousGolden = await readFile(goldenPath);
  const previousDeferred = await readFile(deferredGoldenPath);
  await writeFile(goldenTemporary, goldenJson, "utf8");
  await writeFile(deferredTemporary, deferredJson, "utf8");
  let deferredInstalled = false;
  try {
    await rename(deferredTemporary, deferredGoldenPath);
    deferredInstalled = true;
    await rename(goldenTemporary, goldenPath);
  } catch (error) {
    if (deferredInstalled) await writeFile(deferredGoldenPath, previousDeferred);
    await writeFile(goldenPath, previousGolden);
    throw error;
  } finally {
    await unlink(goldenTemporary).catch(() => undefined);
    await unlink(deferredTemporary).catch(() => undefined);
  }
};

export const runGoldens = async (mode: Mode) => {
  if (mode === "check") {
    const { expected } = await readBankedPair();
    const expectedRow = expected as Row;
    const replay = await executeHarness({
      mode: "check",
      replayCassettePath: cassettePath,
      identityFixture: expectedRow.first as Row,
      renderFixtures: [expectedRow.first as Row, expectedRow.second as Row],
      repairRenderHeading: (expectedRow.steeringFixtures as Row | undefined)
        ?.repairRenderHeading as string | undefined,
    });
    const diagnosticActualPath = process.env.GOLDENS_DIAGNOSTIC_ACTUAL;
    if (diagnosticActualPath !== undefined) {
      await writeFile(
        diagnosticActualPath,
        `${JSON.stringify(replay.artifacts, null, 2)}\n`,
        "utf8",
      );
    }
    const diff = compareArtifacts(expected, replay.artifacts);
    if (diff !== undefined) {
      throw new Error(
        `TypeScript golden lane failed alpha-exact comparison (${JSON.stringify(replay.proxyStats)}):\n${diff}`,
      );
    }
    if (replay.proxyStats.rawHits < 1)
      throw new Error("TypeScript golden lane reached no raw-tier cassette hits");
    if (replay.proxyStats.alphaFallbacks !== 0 || replay.proxyStats.misses !== 0) {
      throw new Error(
        `TypeScript golden lane requires raw-only replay: ${JSON.stringify(replay.proxyStats)}`,
      );
    }
    return { result: "alpha-exact", goldenPath, cassettePath, proxyStats: replay.proxyStats };
  }
  if (mode === "record" && process.env.GOLDENS_RECORD !== "1")
    throw new Error("recording requires GOLDENS_RECORD=1");
  if (mode === "record-deferred") {
    const { expected, cassette } = await readBankedPair();
    const replay = await replayBanked(expected);
    await writeFile(
      deferredGoldenPath,
      `${JSON.stringify({ recordingId: cassette.recordingId, ...replay.scenarios }, null, 2)}\n`,
      "utf8",
    );
    return {
      result: "deferred-recorded-from-replay",
      goldenPath: deferredGoldenPath,
      cassettePath,
      proxyStats: replay.proxyStats,
    };
  }
  if (mode === "regenerate") {
    const { expected, cassette } = await readBankedPair();
    const replay = await executeHarness({
      mode: "check",
      replayCassettePath: cassettePath,
      identityFixture: expected.first as Row,
      renderFixtures: [expected.first as Row, expected.second as Row],
      repairRenderHeading: (expected.steeringFixtures as Row | undefined)?.repairRenderHeading as
        | string
        | undefined,
    });
    if (replay.proxyStats.misses !== 0)
      throw new Error(`regeneration had ${replay.proxyStats.misses} cassette miss(es)`);
    const priorBaseline = (expected.proxyStats as Row | undefined)?.alphaFallbacks;
    if (typeof priorBaseline !== "number")
      throw new Error("banked golden is missing proxyStats.alphaFallbacks baseline");
    if (replay.proxyStats.alphaFallbacks > priorBaseline) {
      throw new Error(
        `regeneration exceeded alpha-fallback baseline: ${replay.proxyStats.alphaFallbacks} > ${priorBaseline}`,
      );
    }
    const coherence = await executeHarness({
      mode: "check",
      replayCassettePath: cassettePath,
      identityFixture: (replay.artifacts as Row).first as Row,
      renderFixtures: [
        (replay.artifacts as Row).first as Row,
        (replay.artifacts as Row).second as Row,
      ],
      repairRenderHeading: replay.steeringFixtures.repairRenderHeading,
    });
    if (coherence.proxyStats.misses !== 0)
      throw new Error(
        `regeneration coherence check failed: ${coherence.proxyStats.misses} cassette miss(es)`,
      );
    if (coherence.proxyStats.alphaFallbacks > priorBaseline) {
      throw new Error(
        `regeneration coherence exceeded alpha-fallback baseline: ${coherence.proxyStats.alphaFallbacks} > ${priorBaseline}`,
      );
    }
    const coherenceDiff = compareArtifacts(replay.artifacts, coherence.artifacts);
    if (coherenceDiff !== undefined)
      throw new Error(`regeneration coherence check failed: ${coherenceDiff}`);
    const scenarioDiff = compareJson(replay.scenarios, coherence.scenarios);
    if (scenarioDiff !== undefined)
      throw new Error(`regeneration coherence check failed on scenarios: ${scenarioDiff}`);
    const recordingId = String(cassette.recordingId);
    const goldenJson = `${JSON.stringify({ recordingId, proxyStats: coherence.proxyStats, steeringFixtures: replay.steeringFixtures, ...(replay.artifacts as Record<string, Json>) }, null, 2)}\n`;
    const deferredJson = `${JSON.stringify({ recordingId, ...replay.scenarios }, null, 2)}\n`;
    await installRegenerated(goldenJson, deferredJson, recordingId);
    return {
      result: "regenerated-from-replay",
      goldenPath,
      cassettePath,
      proxyStats: coherence.proxyStats,
    };
  }
  const recordingId = randomUUID();
  const stageDir = await mkdtemp(join(tmpdir(), "gm-goldens-recording-"));
  const candidateCassettePath = join(stageDir, "compile.json");
  try {
    const recording = await executeHarness({
      mode: "record",
      replayCassettePath: candidateCassettePath,
    });
    const cassette = JSON.parse(recording.cassetteJson) as Record<string, Json>;
    cassette.recordingId = recordingId;
    const golden = { recordingId, ...(recording.artifacts as Record<string, Json>) };
    const cassetteJson = `${JSON.stringify(cassette, null, 2)}\n`;
    await writeFile(candidateCassettePath, cassetteJson, "utf8");
    const replay = await executeHarness({
      mode: "check",
      replayCassettePath: candidateCassettePath,
      identityFixture: (recording.artifacts as Row).first as Row,
      renderFixtures: [
        (recording.artifacts as Row).first as Row,
        (recording.artifacts as Row).second as Row,
      ],
      repairRenderHeading: recording.steeringFixtures.repairRenderHeading,
    });
    if (replay.proxyStats.misses !== 0)
      throw new Error(
        `recording coherence check failed: ${replay.proxyStats.misses} cassette miss(es)`,
      );
    let diff: string | undefined;
    try {
      diff = compareArtifacts(recording.artifacts, replay.artifacts);
    } catch (error) {
      await mkdir(reportDir, { recursive: true });
      await writeFile(
        join(reportDir, "coherence.recording.json"),
        `${JSON.stringify(recording.artifacts, null, 2)}\n`,
        "utf8",
      );
      await writeFile(
        join(reportDir, "coherence.replay.json"),
        `${JSON.stringify(replay.artifacts, null, 2)}\n`,
        "utf8",
      );
      throw error;
    }
    if (diff !== undefined) throw new Error(`recording coherence check failed: ${diff}`);
    const coherentGoldenJson = `${JSON.stringify({ ...golden, proxyStats: replay.proxyStats, steeringFixtures: recording.steeringFixtures }, null, 2)}\n`;
    await installPair(cassetteJson, coherentGoldenJson, recordingId);
    return {
      result: "recorded-and-replayed",
      goldenPath,
      cassettePath,
      proxyStats: replay.proxyStats,
    };
  } finally {
    if (process.env.GOLDENS_KEEP_RUN_DIR !== "1")
      await rm(stageDir, { recursive: true, force: true });
  }
};
