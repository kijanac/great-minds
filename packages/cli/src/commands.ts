import { hostname } from "node:os";

import {
  allVaults,
  citationsOf,
  decodeInput,
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
  Email,
  SessionId,
  Uuid,
  type JobProgressSnapshot,
  type ReplySource,
  type RunOutcome,
} from "@great-minds/domain";
import { Console, Effect, Option, Stream } from "effect";

import { connect, type Connection } from "./connection.ts";
import { Credentials } from "./credentials.ts";
import {
  LimitOutOfRange,
  NoVaults,
  ReplyNotCompleted,
  RunStopped,
  StreamEnded,
  VaultChoiceNeeded,
  VaultNameAmbiguous,
  VaultNotFound,
  VaultUseNeedsLogin,
} from "./errors.ts";

const printJson = (value: unknown) => Console.log(JSON.stringify(value, null, 2));

const savedOrNothing = Effect.flatMap(Credentials, (credentials) =>
  credentials.load.pipe(
    Effect.catchTag("CredentialsUnreadable", () => Effect.succeed(Option.none())),
  ),
);

const signedInConnection = Effect.gen(function* () {
  const credentials = yield* Credentials;
  const signedIn = yield* credentials.signedIn;
  const connection = yield* connect(signedIn.apiUrl, signedIn.apiKey);
  return { connection, signedIn };
});

const chooseVault = (connection: Connection, wanted: Option.Option<string>) =>
  Effect.gen(function* () {
    const { items } = yield* connection.use(allVaults(connection.api));
    if (Option.isNone(wanted)) {
      const only = items.length === 1 ? items[0] : undefined;
      if (only !== undefined) return only.id;
      return yield* items.length === 0
        ? new NoVaults()
        : new VaultChoiceNeeded({ count: items.length });
    }
    const name = wanted.value.trim().toLowerCase();
    const byId = items.find((vault) => vault.id === wanted.value.trim());
    if (byId !== undefined) return byId.id;
    const matches = items.filter((vault) => vault.name.trim().toLowerCase() === name);
    const match = matches.length === 1 ? matches[0] : undefined;
    if (match !== undefined) return match.id;
    return yield* matches.length === 0
      ? new VaultNotFound({ vault: wanted.value })
      : new VaultNameAmbiguous({ vault: wanted.value, count: matches.length });
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

export const login = <E, R>(input: {
  readonly email: string;
  readonly url: Option.Option<string>;
  readonly readCode: Effect.Effect<string, E, R>;
}) =>
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const saved = yield* savedOrNothing;
    const apiUrl = credentials.apiUrl(input.url, saved);
    const email = yield* decodeInput(Email, input.email.trim());
    const anonymous = yield* connect(apiUrl, null);
    yield* anonymous.use(anonymous.api.auth.requestCode({ payload: { email } }));
    yield* Console.error(`A sign-in code was sent to ${email}.`);
    const code = yield* input.readCode;
    const tokens = yield* anonymous.use(
      anonymous.api.auth.verifyCode({ payload: { email, code: code.trim() } }),
    );
    const session = yield* connect(apiUrl, tokens.access_token);
    const label = `gm CLI (${hostname()})`;
    const key = yield* session.use(session.api.auth.createApiKey({ payload: { label } }));
    const sameServer = Option.filter(saved, (found) => found.api_url === apiUrl);
    yield* credentials.save({
      api_url: apiUrl,
      api_key: key.raw_key,
      api_key_id: key.id,
      vault_id: Option.getOrNull(
        Option.flatMap(sameServer, (found) => Option.fromNullishOr(found.vault_id)),
      ),
    });
    yield* Console.log(`Signed in as ${email}. Saved key "${label}" to ${credentials.path}.`);
    const previous = Option.flatMap(sameServer, (found) => Option.fromNullishOr(found.api_key_id));
    if (Option.isSome(previous) && previous.value !== key.id)
      yield* session
        .use(session.api.auth.deleteApiKey({ params: { key_id: previous.value } }))
        .pipe(
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.catch((error) =>
            Console.error(
              `Could not revoke the previous key (${errorMessage(error)}); revoke it in Settings: ${previous.value}`,
            ),
          ),
        );
  });

export const logout = () =>
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const loaded = yield* Effect.result(credentials.load);
    if (loaded._tag === "Failure") {
      yield* credentials.clear;
      return yield* Console.log(`Removed the unreadable ${credentials.path}.`);
    }
    if (credentials.keyFromEnvironment)
      yield* Console.error(
        "GM_API_KEY is set; gm logout cannot revoke it. Revoke that key in Settings and unset it.",
      );
    if (Option.isNone(loaded.success))
      return yield* Console.log("No key is saved on this computer.");
    const saved = loaded.success.value;
    yield* credentials.clear;
    if (saved.api_key_id === null)
      return yield* Console.log(
        "Removed the saved key from this computer; it has no recorded id, so revoke it in Settings.",
      );
    const keyId = saved.api_key_id;
    const connection = yield* connect(saved.api_url, saved.api_key);
    const revoked = yield* connection
      .use(connection.api.auth.deleteApiKey({ params: { key_id: keyId } }))
      .pipe(
        Effect.as("revoked"),
        Effect.catchTags({
          NotFound: () => Effect.succeed("gone"),
          Unauthorized: () => Effect.succeed("gone"),
        }),
        Effect.catch((error) => Effect.succeed(errorMessage(error))),
      );
    yield* revoked === "revoked"
      ? Console.log("Signed out: the key was revoked and removed from this computer.")
      : revoked === "gone"
        ? Console.log("Signed out: the key was already revoked; removed it from this computer.")
        : Console.log(
            `Removed the key from this computer, but could not revoke it (${revoked}); revoke it in Settings: ${keyId}`,
          );
  });

export const listVaults = (input: { readonly json: boolean }) =>
  Effect.gen(function* () {
    const { connection, signedIn } = yield* signedInConnection;
    const { items, roles } = yield* connection.use(allVaults(connection.api));
    const chosen = Option.getOrUndefined(
      Option.map(signedIn.vault, (wanted) => wanted.trim().toLowerCase()),
    );
    const isDefault = (vault: (typeof items)[number]) =>
      chosen !== undefined && (vault.id === chosen || vault.name.trim().toLowerCase() === chosen);
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
  readonly session: Option.Option<string>;
  readonly vault: Option.Option<string>;
  readonly json: boolean;
}) =>
  Effect.gen(function* () {
    const { connection, vaultId } = yield* vaultConnection(input.vault);
    const existing = Option.isSome(input.session)
      ? Option.some(yield* decodeInput(SessionId, input.session.value))
      : Option.none<SessionId>();
    const created = yield* connection.use(
      connection.api.replies.createReply({
        params: { vault_id: vaultId },
        payload: replyRequest({
          question: input.question,
          exchangeId: newUuid(),
          originScope: "vault",
          conversation: Option.isSome(existing)
            ? { kind: "existing", id: existing.value }
            : { kind: "new", conversationKind: "session", idempotencyKey: newUuid() },
        }),
      }),
    );
    const shown = new Set<string>();
    const last = yield* connection
      .follow(followReply(connection.api, vaultId, created.reply_id))
      .pipe(
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
        Stream.runLast,
      );
    if (Option.isNone(last)) return yield* new StreamEnded({ what: "answer" });
    const reply = last.value;
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
    const last = yield* connection.follow(followJob(connection.api, vaultId, jobId)).pipe(
      Stream.tap((snapshot) =>
        Effect.forEach(
          snapshot.track,
          (stage) => {
            if (stageStatus.get(stage.key) === stage.status || stage.status === "pending")
              return Effect.void;
            stageStatus.set(stage.key, stage.status);
            const mark = stage.status === "completed" ? "✓" : stage.status === "failed" ? "✗" : "…";
            return stage.status === "skipped"
              ? Effect.void
              : Console.error(`${mark} ${stage.title}`);
          },
          { discard: true },
        ),
      ),
      Stream.runLast,
    );
    if (Option.isNone(last)) return yield* new StreamEnded({ what: "run" });
    const run: JobProgressSnapshot = last.value;
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
  readonly run: string;
  readonly vault: Option.Option<string>;
  readonly json: boolean;
}) =>
  Effect.gen(function* () {
    const { connection, vaultId } = yield* vaultConnection(input.vault);
    const runId = yield* decodeInput(Uuid, input.run);
    yield* followRun(connection, vaultId, runId, input.json);
  });

export const listRuns = (input: {
  readonly vault: Option.Option<string>;
  readonly limit: number;
  readonly json: boolean;
}) =>
  Effect.gen(function* () {
    if (input.limit < 1 || input.limit > 200)
      return yield* new LimitOutOfRange({ limit: input.limit });
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
        `(${page.items.length} of ${page.pagination.total}; --limit shows more)`,
      );
  });
