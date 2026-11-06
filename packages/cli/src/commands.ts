import { hostname } from "node:os";

import {
  allVaults,
  citationsOf,
  errorMessage,
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
  type Email,
  type JobProgressSnapshot,
  type ReplySource,
  type RunOutcome,
  type SessionId,
  type Uuid,
  type Vault,
} from "@great-minds/domain";
import { Console, Effect, Option, Stream } from "effect";

import { connect, type Connection } from "./connection.ts";
import { Credentials } from "./credentials.ts";
import {
  KeyNotRevoked,
  ReplyNotCompleted,
  RunStopped,
  StreamEnded,
  VaultChoiceNeeded,
  VaultNameAmbiguous,
  VaultNotAccessible,
  VaultNotFound,
  VaultUseNeedsLogin,
} from "./errors.ts";

const printJson = (value: unknown) => Console.log(JSON.stringify(value, null, 2));

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

export const login = <E, R>(input: {
  readonly email: Email;
  readonly url: Option.Option<string>;
  readonly readCode: Effect.Effect<string, E, R>;
}) =>
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const saved = yield* credentials.load.pipe(
      Effect.catchTag("CredentialsUnreadable", () => Effect.succeed(Option.none())),
    );
    const apiUrl = yield* credentials.apiUrl(input.url, saved);
    const anonymous = yield* connect(apiUrl, null);
    yield* anonymous.use(anonymous.api.auth.requestCode({ payload: { email: input.email } }));
    yield* Console.error(`A sign-in code was sent to ${input.email}.`);
    const code = yield* input.readCode;
    const tokens = yield* anonymous.use(
      anonymous.api.auth.verifyCode({ payload: { email: input.email, code: code.trim() } }),
    );
    const session = yield* connect(apiUrl, tokens.access_token);
    const label = `gm CLI (${hostname()})`;
    const key = yield* session.use(session.api.auth.createApiKey({ payload: { label } }));
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
    yield* Console.log(`Signed in as ${input.email}. Saved key "${label}" to ${credentials.path}.`);
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
      const cited = citationsOf(reply.answer);
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
    if (!json)
      for (const line of run.outcome === null ? ["Update finished."] : outcomeLines(run.outcome))
        yield* Console.log(line);
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
