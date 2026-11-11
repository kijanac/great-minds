import { hostname } from "node:os";
import { basename, join } from "node:path";

import {
  allVaults,
  errorMessage,
  fingerprint,
  manifestOf,
  uploadTarget,
  type UploadFile,
  followJob,
  followReply,
  newUuid,
  outcomeHeadline,
  plural,
  replyRequest,
  stoppedHeadline,
} from "@great-minds/client";
import {
  isUuid,
  uploadKind,
  Validation,
  type ChunkRangeQuery,
  type PageParams,
  type JobProgressSnapshot,
  type PublicationPaper,
  type SessionExportSelection,
  type ReplySource,
  type RunOutcome,
  type SessionId,
  type Uuid,
  type Vault,
} from "@great-minds/domain";
import { Console, Effect, FileSystem, Option, Stream } from "effect";

import { CliFetch, connect, type Connection } from "./connection.ts";
import { Credentials } from "./credentials.ts";
import {
  ApiCallFailed,
  KeyNotRevoked,
  LoginCancelled,
  LoginExpired,
  NothingToAdd,
  UploadsIncomplete,
  ReplyNotCompleted,
  RunStopped,
  StreamEnded,
  VaultChoiceNeeded,
  VaultNameAmbiguous,
  VaultNotAccessible,
  VaultNotFound,
  VaultUseNeedsLogin,
} from "./errors.ts";

type ReadOptions = { readonly vault: Option.Option<string>; readonly json: boolean };

const printJson = (value: unknown) => Console.log(JSON.stringify(value, null, 2));

const printPage = <A>(
  page: {
    readonly items: readonly A[];
    readonly pagination: { readonly offset: number; readonly total: number };
  },
  json: boolean,
  empty: string,
  line: (item: A) => string,
) =>
  Effect.gen(function* () {
    if (json) return yield* printJson(page);
    const { offset, total } = page.pagination;
    if (page.items.length === 0)
      return yield* Console.log(total === 0 ? empty : `No items at this offset (${total} total).`);
    for (const item of page.items) yield* Console.log(line(item));
    const last = offset + page.items.length;
    if (last < total || offset > 0)
      yield* Console.error(
        `(${offset + 1}-${last} of ${total}${last < total ? `; --offset ${last} shows more` : ""})`,
      );
  });

const signedInConnection = Effect.gen(function* () {
  const credentials = yield* Credentials;
  const signedIn = yield* credentials.signedIn;
  const connection = yield* connect(signedIn.apiUrl, signedIn.apiKey);
  return { connection, signedIn };
});

const normalized = (value: string) => value.trim().toLowerCase();
const isVault = (vault: Vault, wanted: string) =>
  vault.id === normalized(wanted) || normalized(vault.name) === normalized(wanted);

const chooseVault = (connection: Connection, wanted: Option.Option<string>) =>
  Effect.gen(function* () {
    const id = Option.map(wanted, normalized);
    if (Option.isSome(wanted) && Option.isSome(id) && isUuid(id.value)) {
      const vaultId = id.value;
      const vault = yield* connection
        .use(connection.api.vaults.getVault({ params: { vault_id: vaultId } }))
        .pipe(
          Effect.catchTags({
            Forbidden: () => Effect.fail(new VaultNotAccessible({ vault: wanted.value })),
            NotFound: () => Effect.fail(new VaultNotAccessible({ vault: wanted.value })),
          }),
        );
      return vault.id;
    }
    const { items } = yield* connection.use(allVaults(connection.api));
    if (Option.isNone(wanted)) {
      const [only, ...rest] = items;
      if (only !== undefined && rest.length === 0) return only.id;
      return yield* new VaultChoiceNeeded({ count: items.length });
    }
    const [match, ...others] = items.filter((vault) => isVault(vault, wanted.value));
    if (match !== undefined && others.length === 0) return match.id;
    return yield* match === undefined
      ? new VaultNotFound({ vault: wanted.value })
      : new VaultNameAmbiguous({ vault: wanted.value, count: others.length + 1 });
  });

const vaultConnection = (flag: Option.Option<string>) =>
  Effect.gen(function* () {
    const { connection, signedIn } = yield* signedInConnection;
    const vaultId = yield* chooseVault(
      connection,
      Option.orElse(flag, () => signedIn.vault),
    );
    return { connection, vaultId };
  });

type Revocation = "revoked" | "gone" | { readonly failed: string };

const revokeKey = (connection: Connection, keyId: Uuid) =>
  connection.use(connection.api.auth.deleteApiKey({ params: { key_id: keyId } })).pipe(
    Effect.as<Revocation>("revoked"),
    Effect.catchTags({
      NotFound: () => Effect.succeed<Revocation>("gone"),
      Unauthorized: () => Effect.succeed<Revocation>("gone"),
    }),
    Effect.catch((error) => Effect.succeed<Revocation>({ failed: errorMessage(error) })),
  );

const lastSnapshot = <A, E, R>(snapshots: Stream.Stream<A, E, R>, what: "answer" | "run") =>
  Stream.runLast(snapshots).pipe(
    Effect.flatMap((last) =>
      Option.isSome(last) ? Effect.succeed(last.value) : Effect.fail(new StreamEnded({ what })),
    ),
  );

const awaitApproval = (connection: Connection, deviceCode: string, intervalSeconds: number) =>
  Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(`${intervalSeconds} seconds`);
      const result = yield* connection.use(
        connection.api.auth.pollCliLogin({ payload: { device_code: deviceCode } }),
      );
      if (result.status === "approved") return result;
      if (result.status === "denied") return yield* new LoginCancelled();
      if (result.status === "expired") return yield* new LoginExpired();
    }
  });

export const login = (input: { readonly url: Option.Option<string> }) =>
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const saved = yield* credentials.load.pipe(
      Effect.catchTag("CredentialsUnreadable", () => Effect.succeed(Option.none())),
    );
    const apiUrl = yield* credentials.apiUrl(input.url, saved);
    const anonymous = yield* connect(apiUrl, null);
    const started = yield* anonymous.use(
      anonymous.api.auth.startCliLogin({ payload: { computer: hostname() } }),
    );
    yield* Console.error(
      `To sign in, open:\n  ${started.verification_url_complete}\nand check it shows this code: ${started.user_code}\n\nWaiting for approval…`,
    );
    const approved = yield* awaitApproval(anonymous, started.device_code, started.interval_seconds);
    const key = approved.api_key;
    const session = yield* connect(apiUrl, key.raw_key);
    const sameServer = Option.filter(saved, (found) => found.api_url === apiUrl);
    yield* credentials
      .save({
        api_url: apiUrl,
        api_key: key.raw_key,
        api_key_id: key.id,
        vault_id: Option.getOrNull(
          Option.flatMap(sameServer, (found) => Option.fromNullishOr(found.vault_id)),
        ),
      })
      .pipe(Effect.onError(() => revokeKey(session, key.id)));
    yield* Console.log(
      `Signed in as ${approved.email}. Saved key "${key.label}" to ${credentials.path}.`,
    );
    if (credentials.keyFromEnvironment)
      yield* Console.error(
        "GM_API_KEY is set and takes precedence over this key until you unset it.",
      );
    const previous = Option.flatMap(sameServer, (found) => Option.fromNullishOr(found.api_key_id));
    if (Option.isNone(previous) || previous.value === key.id) return;
    const revoked = yield* revokeKey(session, previous.value);
    if (typeof revoked === "object")
      yield* Console.error(
        `Could not revoke the previous key (${revoked.failed}); revoke it in Settings: ${previous.value}`,
      );
  });

export const logout = () =>
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    if (credentials.keyFromEnvironment)
      yield* Console.error(
        "GM_API_KEY is set; gm logout cannot revoke it. Revoke that key in Settings and unset it.",
      );
    const loaded = yield* Effect.result(credentials.load);
    if (loaded._tag === "Failure") {
      yield* credentials.clear;
      return yield* Console.log(`Removed the unreadable ${credentials.path}.`);
    }
    if (Option.isNone(loaded.success))
      return yield* Console.log("No key is saved on this computer.");
    const saved = loaded.success.value;
    if (saved.api_key_id === null) {
      yield* credentials.clear;
      return yield* Console.log(
        "Removed the saved key from this computer; it has no recorded id, so revoke it in Settings.",
      );
    }
    const revoked = yield* revokeKey(
      yield* connect(saved.api_url, saved.api_key),
      saved.api_key_id,
    );
    if (typeof revoked === "object")
      return yield* new KeyNotRevoked({ keyId: saved.api_key_id, reason: revoked.failed });
    yield* credentials.clear;
    yield* Console.log(
      revoked === "revoked"
        ? "Signed out: the key was revoked and removed from this computer."
        : "Signed out: the key no longer worked; removed it from this computer.",
    );
  });

export const listVaults = (input: { readonly json: boolean }) =>
  Effect.gen(function* () {
    const { connection, signedIn } = yield* signedInConnection;
    const { items, roles } = yield* connection.use(allVaults(connection.api));
    const isDefault = (vault: Vault) =>
      Option.isSome(signedIn.vault) && isVault(vault, signedIn.vault.value);
    if (input.json)
      return yield* printJson(
        items.map((vault) => ({
          ...vault,
          role: roles[vault.id] ?? null,
          default: isDefault(vault),
        })),
      );
    if (items.length === 0) return yield* Console.log("No vaults.");
    for (const vault of items)
      yield* Console.log(
        `${isDefault(vault) ? "*" : " "} ${vault.name}  (${(roles[vault.id] ?? "member").toLowerCase()})  ${vault.id}`,
      );
  });

export const useVault = (input: { readonly vault: string }) =>
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const saved = yield* credentials.load;
    if (Option.isNone(saved) || credentials.keyFromEnvironment)
      return yield* new VaultUseNeedsLogin();
    const connection = yield* connect(saved.value.api_url, saved.value.api_key);
    const vaultId = yield* chooseVault(connection, Option.some(input.vault));
    yield* credentials.save({ ...saved.value, vault_id: vaultId });
    yield* Console.log(`Default vault set to ${input.vault}.`);
    if (credentials.vaultFromEnvironment)
      yield* Console.error("GM_VAULT is set and takes precedence until you unset it.");
  });

const describeStep = (source: ReplySource) => {
  switch (source.type) {
    case "search":
      return source.scope === "web"
        ? `searching the web for "${source.label}"`
        : `searching for "${source.label}"`;
    case "query":
      return `filtering sources: ${source.label}`;
    case "links":
      return `following links from ${source.title ?? source.label}`;
    case "article":
    case "raw":
      return `reading ${source.title ?? source.label}`;
  }
};

export const ask = (input: {
  readonly question: string;
  readonly session: Option.Option<SessionId>;
  readonly vault: Option.Option<string>;
  readonly json: boolean;
}) =>
  Effect.gen(function* () {
    const { connection, vaultId } = yield* vaultConnection(input.vault);
    const created = yield* connection.use(
      connection.api.replies.createReply({
        params: { vault_id: vaultId },
        payload: replyRequest({
          question: input.question,
          exchangeId: newUuid(),
          originScope: "vault",
          conversation: Option.isSome(input.session)
            ? { kind: "existing", id: input.session.value }
            : { kind: "new", conversationKind: "session", idempotencyKey: newUuid() },
        }),
      }),
    );
    const shown = new Set<string>();
    const reply = yield* lastSnapshot(
      connection.follow(followReply(connection.api, vaultId, created.reply_id)).pipe(
        Stream.tap((snapshot) =>
          Effect.forEach(
            snapshot.sources,
            (source) => {
              const key = `${source.type}\u0000${source.label}`;
              if (source.pending === true || shown.has(key)) return Effect.void;
              shown.add(key);
              return Console.error(`  ${describeStep(source)}`);
            },
            { discard: true },
          ),
        ),
      ),
      "answer",
    );
    if (input.json) yield* printJson(reply);
    if (reply.status !== "completed")
      return yield* new ReplyNotCompleted({ status: reply.status, error: reply.error });
    if (!input.json) {
      yield* Console.log(reply.answer.trim());
      const cited = reply.citations;
      if (cited.length > 0) {
        yield* Console.log("");
        yield* Console.log("Sources:");
        for (const citation of cited)
          yield* Console.log(`  [${citation.n}] ${citation.label}  ${citation.path}`);
      }
    }
    yield* Console.error(
      `session ${reply.session_id}  (follow up: gm ask --session ${reply.session_id} "…")`,
    );
  });

const outcomeLines = (outcome: RunOutcome) => {
  const lines = [`${outcomeHeadline(outcome)}.`];
  if (outcome.sources > 0) lines.push(`From ${plural(outcome.sources, "new or edited source")}.`);
  const groups: readonly (readonly [string, readonly string[]])[] = [
    ["New", outcome.added.map((article) => article.title)],
    ["Updated", outcome.changed.map((article) => article.title)],
    [
      "Removed",
      outcome.removed.map((article) =>
        article.merged_into === undefined
          ? article.title
          : `${article.title}  (merged into ${article.merged_into.title})`,
      ),
    ],
  ];
  for (const [label, entries] of groups)
    if (entries.length > 0) lines.push("", `${label}:`, ...entries.map((entry) => `  ${entry}`));
  return lines;
};

const followRun = (connection: Connection, vaultId: Uuid, jobId: Uuid, json: boolean) =>
  Effect.gen(function* () {
    const stageStatus = new Map<string, string>();
    const run: JobProgressSnapshot = yield* lastSnapshot(
      connection.follow(followJob(connection.api, vaultId, jobId)).pipe(
        Stream.tap((snapshot) =>
          Effect.forEach(
            snapshot.track,
            (stage) => {
              if (stageStatus.get(stage.key) === stage.status || stage.status === "pending")
                return Effect.void;
              stageStatus.set(stage.key, stage.status);
              const mark =
                stage.status === "completed" ? "✓" : stage.status === "failed" ? "✗" : "…";
              return stage.status === "skipped"
                ? Effect.void
                : Console.error(`${mark} ${stage.title}`);
            },
            { discard: true },
          ),
        ),
      ),
      "run",
    );
    if (json) yield* printJson(run);
    if (run.job_status === "cancelled")
      return yield* new RunStopped({ headline: stoppedHeadline("cancelled", null), error: null });
    if (run.job_status === "failed" || run.phase_status === "failed") {
      const stopped = run.track.find((stage) => stage.status === "failed");
      return yield* new RunStopped({
        headline: stoppedHeadline("failed", stopped?.title ?? null),
        error: run.error ?? null,
      });
    }
    if (run.job_status !== "completed") return yield* new StreamEnded({ what: "run" });
    if (!json) {
      for (const line of run.outcome === null ? ["Update finished."] : outcomeLines(run.outcome))
        yield* Console.log(line);
      for (const warning of run.warnings) {
        yield* Console.error(`Left out: ${warning.count} ${warning.message}`);
        for (const item of warning.items) yield* Console.error(`  ${item}`);
      }
    }
  });

export const update = (input: { readonly vault: Option.Option<string>; readonly json: boolean }) =>
  Effect.gen(function* () {
    const { connection, vaultId } = yield* vaultConnection(input.vault);
    const job = yield* connection.use(
      connection.api.compile.requestCompile({
        params: { vault_id: vaultId },
        payload: { job_id: newUuid() },
      }),
    );
    yield* Console.error(`Update ${job.id} (gm run ${job.id} to follow it again)`);
    yield* followRun(connection, vaultId, job.id, input.json);
  });

export const followExistingRun = (input: {
  readonly run: Uuid;
  readonly vault: Option.Option<string>;
  readonly json: boolean;
}) =>
  Effect.gen(function* () {
    const { connection, vaultId } = yield* vaultConnection(input.vault);
    yield* followRun(connection, vaultId, input.run, input.json);
  });

export const listRuns = (input: {
  readonly vault: Option.Option<string>;
  readonly limit: number;
  readonly json: boolean;
}) =>
  Effect.gen(function* () {
    const { connection, vaultId } = yield* vaultConnection(input.vault);
    const page = yield* connection.use(
      connection.api.jobs.listJobs({
        params: { vault_id: vaultId },
        query: { limit: input.limit, offset: 0 },
      }),
    );
    if (input.json) return yield* printJson(page);
    if (page.items.length === 0) return yield* Console.log("No runs yet.");
    for (const run of page.items)
      yield* Console.log(
        `${run.id}  ${run.status.padEnd(9)}  ${run.created_at.toISOString().slice(0, 16).replace("T", " ")}  ${run.trigger}`,
      );
    if (page.pagination.total > page.items.length)
      yield* Console.error(
        `(${page.items.length} of ${page.pagination.total}; --limit up to 200 shows more)`,
      );
  });

const UPLOAD_CONCURRENCY = 4;

const isHidden = (path: string) => path.split(/[\\/]/).some((part) => part.startsWith("."));

const filesUnder = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs.stat(path);
    if (info.type !== "Directory") return [path];
    const entries = yield* fs.readDirectory(path, { recursive: true });
    const files = yield* Effect.forEach(
      entries.filter((entry) => !isHidden(entry)).map((entry) => join(path, entry)),
      (entry) => Effect.map(fs.stat(entry), (stat) => (stat.type === "File" ? [entry] : [])),
    );
    return files.flat().sort();
  });

const readUpload = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const bytes = yield* fs.readFile(path);
    const content = new Blob([new Uint8Array(bytes)]);
    const hash = yield* Effect.promise(() => fingerprint(content));
    return { path, name: basename(path), content, hash, mimetype: "" };
  });

export const add = (input: {
  readonly paths: readonly string[];
  readonly vault: Option.Option<string>;
  readonly json: boolean;
}) =>
  Effect.gen(function* () {
    const found = (yield* Effect.forEach(input.paths, filesUnder)).flat();
    const supported = found.filter((path) => uploadKind(basename(path), "") !== null);
    const { connection, vaultId } = yield* vaultConnection(input.vault);
    const read = yield* Effect.forEach(supported, readUpload, { concurrency: UPLOAD_CONCURRENCY });
    const { existing } = yield* connection.use(
      connection.api.ingest.checkFileIngestDupes({
        params: { vault_id: vaultId },
        payload: { client_hashes: [...new Set(read.map((file) => file.hash))] },
      }),
    );
    const known = new Set<string>(existing);
    const files: (UploadFile & { readonly path: string })[] = [];
    for (const file of read) {
      if (known.has(file.hash)) continue;
      known.add(file.hash);
      files.push(file);
    }
    const skipped = found.length - files.length;
    if (files.length === 0) return yield* new NothingToAdd({ skipped: found.length });
    if (skipped > 0)
      yield* Console.error(
        `Skipping ${plural(skipped, "file")}: already in the vault, repeated or unsupported.`,
      );
    const batch = yield* connection.use(
      connection.api.ingest.createFileIngest({
        params: { vault_id: vaultId },
        payload: { batch_id: newUuid(), files: manifestOf(files) },
      }),
    );
    const byHash = new Map(files.map((file) => [file.hash, file]));
    const failed = yield* Effect.forEach(
      batch.targets,
      (target) => {
        const file = byHash.get(target.hash);
        if (file === undefined) return Effect.succeed([]);
        return uploadTarget(connection, batch, target, file).pipe(
          Effect.andThen(Console.error(`  uploaded ${file.path}`)),
          Effect.as([]),
          Effect.catch((error) => Effect.succeed([`${file.path}: ${errorMessage(error)}`])),
        );
      },
      { concurrency: UPLOAD_CONCURRENCY },
    );
    const failures = failed.flat();
    if (failures.length > 0)
      return yield* new UploadsIncomplete({ failed: failures, total: files.length });
    const job = yield* connection.use(
      connection.api.ingest.commitFileIngest({ params: { batch_id: batch.id } }),
    );
    yield* Console.error(
      `Added ${plural(files.length, "file")}; run ${job.id} (gm run ${job.id} to follow it again)`,
    );
    yield* followRun(connection, vaultId, job.id, input.json);
  });

const shortDate = (date: Date) => date.toISOString().slice(0, 16).replace("T", " ");

export const listSources = (input: {
  readonly vault: Option.Option<string>;
  readonly tags: ReadonlyArray<string>;
  readonly author: Option.Option<string>;
  readonly genre: Option.Option<string>;
  readonly from: Option.Option<string>;
  readonly to: Option.Option<string>;
  readonly fields: Option.Option<Record<string, string>>;
  readonly sort: "date" | "date_desc" | "title";
  readonly limit: number;
  readonly offset: number;
  readonly json: boolean;
}) =>
  Effect.gen(function* () {
    const { connection, vaultId } = yield* vaultConnection(input.vault);
    const page = yield* connection.use(
      connection.api.sources.querySources({
        params: { vault_id: vaultId },
        payload: {
          ...(input.tags.length === 0 ? {} : { tags: input.tags }),
          ...Option.match(input.author, { onNone: () => ({}), onSome: (author) => ({ author }) }),
          ...Option.match(input.genre, { onNone: () => ({}), onSome: (genre) => ({ genre }) }),
          ...Option.match(input.from, {
            onNone: () => ({}),
            onSome: (date_from) => ({ date_from }),
          }),
          ...Option.match(input.to, { onNone: () => ({}), onSome: (date_to) => ({ date_to }) }),
          ...Option.match(input.fields, { onNone: () => ({}), onSome: (fields) => ({ fields }) }),
          sort: input.sort,
          limit: input.limit,
          offset: input.offset,
        },
      }),
    );
    yield* printPage(page, input.json, "No sources match.", (source) => {
      const by = source.author === null ? "" : `  ${source.author}`;
      const date = source.published_date === null ? "" : `  ${source.published_date}`;
      return `${source.file_path}  ${source.title ?? ""}${by}${date}`;
    });
  });

export const listSessions = (input: ReadOptions & PageParams) =>
  Effect.gen(function* () {
    const { connection, vaultId } = yield* vaultConnection(input.vault);
    const page = yield* connection.use(
      connection.api.sessions.listSessions({
        params: { vault_id: vaultId },
        query: { limit: input.limit, offset: input.offset },
      }),
    );
    yield* printPage(
      page,
      input.json,
      "No sessions yet.",
      (session) => `${session.id}  ${shortDate(session.updated_at)}  ${session.query}`,
    );
  });

export const readSession = (input: {
  readonly session: SessionId;
  readonly vault: Option.Option<string>;
  readonly json: boolean;
}) =>
  Effect.gen(function* () {
    const { connection, vaultId } = yield* vaultConnection(input.vault);
    const params = { vault_id: vaultId, session_id: input.session };
    if (input.json)
      return yield* printJson(
        yield* connection.use(connection.api.sessions.readSession({ params })),
      );
    yield* Console.log(
      yield* connection.use(connection.api.sessions.readSessionMarkdown({ params })),
    );
  });

export const exportSession = (input: {
  readonly session: SessionId;
  readonly vault: Option.Option<string>;
  readonly format: "pdf" | "markdown";
  readonly paper: PublicationPaper;
  readonly messages: Option.Option<SessionExportSelection["messages"]>;
  readonly output: string;
  readonly json: boolean;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { connection, vaultId } = yield* vaultConnection(input.vault);
    const params = { vault_id: vaultId, session_id: input.session };
    const payload = Option.isSome(input.messages) ? { messages: input.messages.value } : {};
    const bytes =
      input.format === "pdf"
        ? (yield* connection.use(
            connection.api.sessions.prepareSessionExport({
              params,
              payload: { ...payload, paper: input.paper },
            }),
          )).pdf
        : new TextEncoder().encode(
            yield* connection.use(
              connection.api.sessions.prepareSessionMarkdown({ params, payload }),
            ),
          );
    yield* fs.writeFile(input.output, bytes, { flag: "wx", mode: 0o600 });
    if (input.json) return yield* printJson({ path: input.output, format: input.format });
    yield* Console.log(`Saved ${input.format === "pdf" ? "PDF" : "Markdown"} to ${input.output}`);
  });

export const search = (
  input: ReadOptions & { readonly query: string; readonly path: Option.Option<string> },
) =>
  Effect.gen(function* () {
    const { connection, vaultId } = yield* vaultConnection(input.vault);
    const hits = yield* connection.use(
      connection.api.documents.searchVault({
        params: { vault_id: vaultId },
        query: {
          q: input.query,
          ...Option.match(input.path, { onNone: () => ({}), onSome: (path) => ({ path }) }),
        },
      }),
    );
    if (input.json) return yield* printJson(hits);
    if (hits.length === 0) return yield* Console.log("No matching passages.");
    for (const hit of hits)
      yield* Console.log(`${hit.path} [chunk ${hit.chunk_index}]  ${hit.heading}\n${hit.text}\n`);
  });

export const listArticles = (
  input: ReadOptions &
    PageParams & {
      readonly contains: Option.Option<string>;
      readonly tag: Option.Option<string>;
      readonly run: Option.Option<Uuid>;
      readonly sort: "title" | "linked" | "recent";
    },
) =>
  Effect.gen(function* () {
    if (input.sort === "recent" && [input.contains, input.tag, input.run].some(Option.isSome))
      return yield* new Validation({
        detail: "Recent article order cannot be combined with filters.",
      });
    const { connection, vaultId } = yield* vaultConnection(input.vault);
    const params = { vault_id: vaultId };
    const query = { limit: input.limit, offset: input.offset };
    const page = yield* connection.use(
      input.sort === "recent"
        ? connection.api.wiki.listRecentWikiArticles({ params, query })
        : connection.api.wiki.listWikiArticles({
            params,
            query: {
              ...query,
              sort: input.sort,
              ...Option.match(input.contains, {
                onNone: () => ({}),
                onSome: (contains) => ({ contains }),
              }),
              ...Option.match(input.tag, { onNone: () => ({}), onSome: (tag) => ({ tag }) }),
              ...Option.match(input.run, { onNone: () => ({}), onSome: (run) => ({ run }) }),
            },
          }),
    );
    yield* printPage(
      page,
      input.json,
      "No articles match.",
      (article) => `${article.file_path}  ${article.title}`,
    );
  });

export const readChunks = (input: ReadOptions & ChunkRangeQuery) =>
  Effect.gen(function* () {
    const { connection, vaultId } = yield* vaultConnection(input.vault);
    const chunks = yield* connection.use(
      connection.api.documents.readChunks({
        params: { vault_id: vaultId },
        query: { path: input.path, start: input.start, end: input.end },
      }),
    );
    if (input.json) return yield* printJson(chunks);
    if (chunks.length === 0) return yield* Console.log("No chunks in this range.");
    for (const chunk of chunks)
      yield* Console.log(
        `${chunk.path} [chunk ${chunk.chunk_index}]  ${chunk.heading}\n${chunk.body}\n`,
      );
  });

export const readLinks = (input: ReadOptions & { readonly path: string }) =>
  Effect.gen(function* () {
    const { connection, vaultId } = yield* vaultConnection(input.vault);
    const links = yield* connection.use(
      connection.api.documents.readLinks({
        params: { vault_id: vaultId },
        query: { path: input.path },
      }),
    );
    if (input.json) return yield* printJson(links);
    for (const [kind, articles] of Object.entries(links)) {
      yield* Console.log(`${kind}:`);
      if (articles.length === 0) yield* Console.log("  None");
      for (const article of articles)
        yield* Console.log(`  ${article.file_path}  ${article.title}`);
    }
  });

export const readDocument = (input: {
  readonly path: string;
  readonly vault: Option.Option<string>;
  readonly json: boolean;
}) =>
  Effect.gen(function* () {
    const { connection, vaultId } = yield* vaultConnection(input.vault);
    const document = yield* connection.use(
      connection.api.documents.resolveDocument({
        params: { vault_id: vaultId },
        query: { path: input.path },
      }),
    );
    if (input.json) return yield* printJson(document);
    if (document.archived)
      yield* Console.error(
        document.superseded_by === null
          ? "This article is archived."
          : `This article is archived; see ${document.superseded_by}.`,
      );
    yield* Console.log(document.body);
  });

export const callApi = (input: {
  readonly method: string;
  readonly path: string;
  readonly data: Option.Option<string>;
}) =>
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const signedIn = yield* credentials.signedIn;
    const fetch = yield* CliFetch;
    const url = `${signedIn.apiUrl.replace(/\/$/, "")}/${input.path.replace(/^\//, "")}`;
    const response = yield* Effect.promise((signal) =>
      fetch(url, {
        method: input.method.toUpperCase(),
        headers: {
          authorization: `Bearer ${signedIn.apiKey}`,
          ...(Option.isSome(input.data) ? { "content-type": "application/json" } : {}),
        },
        ...(Option.isSome(input.data) ? { body: input.data.value } : {}),
        signal,
      }),
    );
    const body = yield* Effect.promise(() => response.text());
    if (!response.ok) return yield* new ApiCallFailed({ status: response.status, body });
    if (body !== "") yield* Console.log(body);
  });
