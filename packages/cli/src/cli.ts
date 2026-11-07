import { SessionId, Uuid } from "@great-minds/domain";
import { Argument, Command, Flag } from "effect/cli";

import {
  add,
  callApi,
  listSessions,
  readDocument,
  readSession,
  ask,
  followExistingRun,
  listRuns,
  listVaults,
  login,
  logout,
  update,
  useVault,
} from "./commands.ts";

const vaultFlag = Flag.String("vault").pipe(
  Flag.withDescription("Vault name or id (default: gm vault use, GM_VAULT, or your only vault)"),
  Flag.optional,
);
const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Print machine-readable JSON instead of text"),
  Flag.withDefault(false),
);

const loginCommand = Command.make(
  "login",
  { url: Flag.String("url").pipe(Flag.withDescription("API base URL"), Flag.optional) },
  login,
).pipe(
  Command.withDescription("Sign in by approving this computer in your browser; saves an API key"),
);

const logoutCommand = Command.make("logout", {}, logout).pipe(
  Command.withDescription("Revoke this computer's API key and forget it"),
);

const vaultsCommand = Command.make("vaults", { json: jsonFlag }, listVaults).pipe(
  Command.withDescription("List your vaults (* marks the default)"),
);

const vaultUseCommand = Command.make(
  "use",
  { vault: Argument.String("vault").pipe(Argument.withDescription("Vault name or id")) },
  useVault,
).pipe(Command.withDescription("Set the default vault for later commands"));

const vaultCommand = Command.make("vault").pipe(
  Command.withDescription("Choose the default vault"),
  Command.withSubcommands([vaultUseCommand]),
);

const askCommand = Command.make(
  "ask",
  {
    question: Argument.String("question").pipe(Argument.withDescription("Your question")),
    session: Flag.String("session").pipe(
      Flag.withSchema(SessionId),
      Flag.withDescription("Continue an earlier session (its id is printed after each answer)"),
      Flag.optional,
    ),
    vault: vaultFlag,
    json: jsonFlag,
  },
  ask,
).pipe(
  Command.withDescription(
    "Ask the vault a question; shows the agent's steps as it works, then the answer and its sources",
  ),
);

const addCommand = Command.make(
  "add",
  {
    paths: Argument.Path("path", { mustExist: true }).pipe(
      Argument.withDescription("Files or folders to add (folders are read recursively)"),
      Argument.atLeast(1),
    ),
    vault: vaultFlag,
    json: jsonFlag,
  },
  add,
).pipe(
  Command.withDescription(
    "Upload documents, skipping ones already in the vault, and follow the run they start",
  ),
);

const updateCommand = Command.make("update", { vault: vaultFlag, json: jsonFlag }, update).pipe(
  Command.withDescription("Start an Update and follow it to the end"),
);

const runsCommand = Command.make(
  "runs",
  {
    vault: vaultFlag,
    limit: Flag.Int("limit").pipe(
      Flag.filter(
        (limit) => limit >= 1 && limit <= 200,
        (limit) => `--limit must be between 1 and 200 (got ${limit})`,
      ),
      Flag.withDescription("How many runs to list (1-200)"),
      Flag.withDefault(20),
    ),
    json: jsonFlag,
  },
  listRuns,
).pipe(Command.withDescription("List recent Updates and uploads"));

const runCommand = Command.make(
  "run",
  {
    run: Argument.String("id").pipe(
      Argument.withSchema(Uuid),
      Argument.withDescription("Run id (from gm runs)"),
    ),
    vault: vaultFlag,
    json: jsonFlag,
  },
  followExistingRun,
).pipe(Command.withDescription("Follow a run until it ends and show what it changed"));

const limitFlag = Flag.Int("limit").pipe(
  Flag.filter(
    (limit) => limit >= 1 && limit <= 200,
    (limit) => `--limit must be between 1 and 200 (got ${limit})`,
  ),
  Flag.withDescription("How many to list (1-200)"),
  Flag.withDefault(20),
);

const sessionsCommand = Command.make(
  "sessions",
  { vault: vaultFlag, limit: limitFlag, json: jsonFlag },
  listSessions,
).pipe(Command.withDescription("List recent sessions, newest first"));

const sessionCommand = Command.make(
  "session",
  {
    session: Argument.String("id").pipe(
      Argument.withSchema(SessionId),
      Argument.withDescription("Session id (from gm sessions or gm ask)"),
    ),
    vault: vaultFlag,
    json: jsonFlag,
  },
  readSession,
).pipe(Command.withDescription("Print a session as markdown"));

const readCommand = Command.make(
  "read",
  {
    path: Argument.String("path").pipe(
      Argument.withDescription("Document path, e.g. wiki/liquidationism.md or raw/docs/…md"),
    ),
    vault: vaultFlag,
    json: jsonFlag,
  },
  readDocument,
).pipe(Command.withDescription("Print an article or source"));

const apiCommand = Command.make(
  "api",
  {
    method: Argument.Literals("method", ["get", "post", "put", "patch", "delete"]).pipe(
      Argument.withDescription("HTTP method"),
    ),
    path: Argument.String("path").pipe(
      Argument.withDescription("Path under the API base, e.g. vaults or vaults/<id>/wiki"),
    ),
    data: Flag.String("data").pipe(Flag.withDescription("JSON request body"), Flag.optional),
  },
  callApi,
).pipe(Command.withDescription("Call any API endpoint with your key and print the response"));

const gm = Command.make("gm").pipe(
  Command.withDescription("Great Minds from the command line"),
  Command.withSubcommands([
    loginCommand,
    logoutCommand,
    vaultsCommand,
    vaultCommand,
    askCommand,
    addCommand,
    updateCommand,
    runsCommand,
    runCommand,
    sessionsCommand,
    sessionCommand,
    readCommand,
    apiCommand,
  ]),
);

export const runGm = (args: readonly string[], version: string) =>
  Command.runWith(gm, { version })(args);
