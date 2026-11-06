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
import { Data, Effect, Option, Schema, Stream } from "effect";

import { connectForLogin, connectWithKey, type Connection } from "./connection.ts";
import { Credentials, DEFAULT_API_URL } from "./credentials.ts";
import { Output } from "./output.ts";

export class CommandFailed extends Data.TaggedError("CommandFailed")<{
  readonly message: string;
}> {}

const isUuid = Schema.is(Uuid);
const printJson = (value: unknown) => JSON.stringify(value, null, 2);

const connect = Effect.gen(function* () {
  const credentials = yield* Credentials;
  const login = yield* credentials.login;
  const connection = yield* connectWithKey(login.apiUrl, login.apiKey);
  return { connection, login };
});

const chooseVault = (connection: Connection, wanted: Option.Option<string>) =>
  Effect.gen(function* () {
    if (Option.isSome(wanted) && isUuid(wanted.value)) return wanted.value;
    const { items } = yield* connection.use(allVaults(connection.api));
    if (Option.isNone(wanted)) {
      const only = items.length === 1 ? items[0] : undefined;
      if (only !== undefined) return only.id;
      return yield* new CommandFailed({
        message:
          items.length === 0
            ? "you have no vaults yet"
            : "choose a vault: gm vault use <name>, or pass --vault",
      });
    }
    const name = wanted.value.trim().toLowerCase();
    const matches = items.filter((vault) => vault.name.trim().toLowerCase() === name);
    const match = matches.length === 1 ? matches[0] : undefined;
    if (match !== undefined) return match.id;
    return yield* new CommandFailed({
      message:
        matches.length === 0
          ? `no vault named "${wanted.value}" (gm vaults lists yours)`
          : `${matches.length} vaults are named "${wanted.value}"; use its id`,
    });
  });

const connectToVault = (flag: Option.Option<string>) =>
  Effect.gen(function* () {
    const { connection, login } = yield* connect;
    const vaultId = yield* chooseVault(
      connection,
      Option.orElse(flag, () => login.vault),
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
    const output = yield* Output;
    const saved = yield* credentials.load;
    const apiUrl = Option.getOrElse(
      Option.orElse(input.url, () => Option.map(saved, (found) => found.api_url)),
      () => DEFAULT_API_URL,
    );
    const { connection, signIn } = yield* connectForLogin(apiUrl);
    const email = yield* decodeInput(Email, input.email.trim());
    yield* connection.use(connection.api.auth.requestCode({ payload: { email } }));
    yield* output.note(`A sign-in code was sent to ${email}.`);
    const code = yield* input.readCode;
    const tokens = yield* connection.use(
      connection.api.auth.verifyCode({ payload: { email, code: code.trim() } }),
    );
    yield* signIn(tokens);
    const label = `gm CLI (${hostname()})`;
    const key = yield* connection.use(connection.api.auth.createApiKey({ payload: { label } }));
    yield* credentials.save({
      api_url: apiUrl,
      api_key: key.raw_key,
      api_key_id: key.id,
      vault_id: Option.getOrNull(
        Option.flatMap(saved, (found) => Option.fromNullishOr(found.vault_id)),
      ),
    });
    const previous = Option.flatMap(saved, (found) =>
      found.api_url === apiUrl ? Option.fromNullishOr(found.api_key_id) : Option.none(),
    );
    if (Option.isSome(previous) && previous.value !== key.id)
      yield* connection
        .use(connection.api.auth.deleteApiKey({ params: { key_id: previous.value } }))
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    yield* output.line(`Signed in as ${email}. Saved key "${label}" to ${credentials.path}.`);
  });

export const logout = Effect.gen(function* () {
  const credentials = yield* Credentials;
  const output = yield* Output;
  const saved = yield* credentials.load;
  if (Option.isNone(saved)) return yield* output.line("Not signed in on this computer.");
  const keyId = saved.value.api_key_id;
  if (keyId !== null) {
    const connection = yield* connectWithKey(saved.value.api_url, saved.value.api_key);
    yield* connection
      .use(connection.api.auth.deleteApiKey({ params: { key_id: keyId } }))
      .pipe(Effect.catchTags({ NotFound: () => Effect.void, Unauthorized: () => Effect.void }));
  }
  yield* credentials.clear;
  yield* output.line("Signed out; the key was revoked and removed from this computer.");
});

export const listVaults = (input: { readonly json: boolean }) =>
  Effect.gen(function* () {
    const output = yield* Output;
    const { connection, login } = yield* connect;
    const { items, roles } = yield* connection.use(allVaults(connection.api));
    const chosen = Option.getOrNull(login.vault);
    if (input.json)
      return yield* output.line(
        printJson(items.map((vault) => ({ ...vault, role: roles[vault.id] ?? null }))),
      );
    if (items.length === 0) return yield* output.line("No vaults.");
    for (const vault of items)
      yield* output.line(
        `${vault.id === chosen ? "*" : " "} ${vault.name}  (${(roles[vault.id] ?? "member").toLowerCase()})  ${vault.id}`,
      );
  });

export const useVault = (input: { readonly vault: string }) =>
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const output = yield* Output;
    const saved = yield* credentials.load;
    if (Option.isNone(saved))
      return yield* new CommandFailed({
        message: "gm vault use needs gm login; with GM_API_KEY, set GM_VAULT instead",
      });
    const { connection } = yield* connect;
    const vaultId = yield* chooseVault(connection, Option.some(input.vault));
    yield* credentials.save({ ...saved.value, vault_id: vaultId });
    yield* output.line(`Default vault set to ${input.vault}.`);
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
    const output = yield* Output;
    const { connection, vaultId } = yield* connectToVault(input.vault);
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
          conversation: Option.match(existing, {
            onNone: () => ({
              kind: "new" as const,
              conversationKind: "session" as const,
              idempotencyKey: newUuid(),
            }),
            onSome: (id) => ({ kind: "existing" as const, id }),
          }),
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
              return output.note(`  ${describeStep(source)}`);
            },
            { discard: true },
          ),
        ),
        Stream.runLast,
      );
    if (Option.isNone(last))
      return yield* new CommandFailed({ message: "the answer stream ended without a reply" });
    const reply = last.value;
    if (input.json) yield* output.line(printJson(reply));
    if (reply.status !== "completed")
      return yield* new CommandFailed({
        message: `the answer ${reply.status}${reply.error === null ? "" : `: ${reply.error}`}`,
      });
    if (!input.json) {
      yield* output.line(reply.answer.trim());
      const cited = citationsOf(reply.answer);
      if (cited.length > 0) {
        yield* output.line("");
        yield* output.line("Sources:");
        for (const citation of cited)
          yield* output.line(`  [${citation.n}] ${citation.label}  ${citation.path}`);
      }
    }
    yield* output.note(
      `session ${reply.session_id}  (follow up: gm ask --session ${reply.session_id} "…")`,
    );
  });

const outcomeLines = (outcome: RunOutcome) => {
  const lines = [`${outcomeHeadline(outcome)}.`];
  if (outcome.sources > 0) lines.push(`From ${plural(outcome.sources, "new or edited source")}.`);
  const group = (label: string, entries: readonly string[]) =>
    entries.length === 0 ? [] : ["", `${label}:`, ...entries.map((entry) => `  ${entry}`)];
  lines.push(
    ...group(
      "New",
      outcome.added.map((article) => article.title),
    ),
  );
  lines.push(
    ...group(
      "Updated",
      outcome.changed.map((article) => article.title),
    ),
  );
  lines.push(
    ...group(
      "Removed",
      outcome.removed.map((article) =>
        article.merged_into === undefined
          ? article.title
          : `${article.title}  (merged into ${article.merged_into.title})`,
      ),
    ),
  );
  return lines;
};

const followRun = (connection: Connection, vaultId: Uuid, jobId: Uuid, json: boolean) =>
  Effect.gen(function* () {
    const output = yield* Output;
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
            return stage.status === "skipped" ? Effect.void : output.note(`${mark} ${stage.title}`);
          },
          { discard: true },
        ),
      ),
      Stream.runLast,
    );
    if (Option.isNone(last))
      return yield* new CommandFailed({ message: "the run's progress stream ended early" });
    const run: JobProgressSnapshot = last.value;
    if (json) yield* output.line(printJson(run));
    if (run.job_status === "cancelled")
      return yield* new CommandFailed({ message: stoppedHeadline("cancelled", null) });
    if (run.job_status === "failed" || run.phase_status === "failed") {
      const stopped = run.track.find((stage) => stage.status === "failed");
      return yield* new CommandFailed({
        message: `${stoppedHeadline("failed", stopped?.title ?? null)}${run.error === undefined ? "" : `: ${run.error}`}`,
      });
    }
    if (!json)
      for (const line of run.outcome === null ? ["Update finished."] : outcomeLines(run.outcome))
        yield* output.line(line);
  });

export const update = (input: { readonly vault: Option.Option<string>; readonly json: boolean }) =>
  Effect.gen(function* () {
    const output = yield* Output;
    const { connection, vaultId } = yield* connectToVault(input.vault);
    const job = yield* connection.use(
      connection.api.compile.requestCompile({
        params: { vault_id: vaultId },
        payload: { job_id: newUuid() },
      }),
    );
    yield* output.note(`Update ${job.id} (gm run ${job.id} to follow it again)`);
    yield* followRun(connection, vaultId, job.id, input.json);
  });

export const followExistingRun = (input: {
  readonly run: string;
  readonly vault: Option.Option<string>;
  readonly json: boolean;
}) =>
  Effect.gen(function* () {
    const { connection, vaultId } = yield* connectToVault(input.vault);
    const runId = yield* decodeInput(Uuid, input.run);
    yield* followRun(connection, vaultId, runId, input.json);
  });

export const listRuns = (input: {
  readonly vault: Option.Option<string>;
  readonly limit: number;
  readonly json: boolean;
}) =>
  Effect.gen(function* () {
    const output = yield* Output;
    const { connection, vaultId } = yield* connectToVault(input.vault);
    const page = yield* connection.use(
      connection.api.jobs.listJobs({
        params: { vault_id: vaultId },
        query: { limit: input.limit, offset: 0 },
      }),
    );
    if (input.json) return yield* output.line(printJson(page.items));
    if (page.items.length === 0) return yield* output.line("No runs yet.");
    for (const run of page.items)
      yield* output.line(
        `${run.id}  ${run.status.padEnd(9)}  ${run.created_at.toISOString().slice(0, 16).replace("T", " ")}  ${run.trigger}`,
      );
  });

export const userMessage = (error: unknown) => errorMessage(error, "Something went wrong.");
