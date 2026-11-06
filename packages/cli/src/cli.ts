import { Email, SessionId, Uuid } from "@great-minds/domain";
import { Effect, Redacted } from "effect";
import { Argument, Command, Flag, Prompt } from "effect/unstable/cli";

import {
  ask,
  followExistingRun,
  listRuns,
  listVaults,
  login,
  logout,
  update,
  useVault,
} from "./commands.ts";

const vaultFlag = Flag.string("vault").pipe(
  Flag.withDescription("Vault name or id (default: gm vault use, GM_VAULT, or your only vault)"),
  Flag.optional,
);
const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("Print machine-readable JSON instead of text"),
  Flag.withDefault(false),
);

const loginCommand = Command.make(
  "login",
  {
    email: Argument.string("email").pipe(
      Argument.withSchema(Email),
      Argument.withDescription("Your account's email address"),
    ),
    url: Flag.string("url").pipe(Flag.withDescription("API base URL"), Flag.optional),
  },
  (input) =>
    login({
      email: input.email,
      url: input.url,
      readCode: Prompt.run(Prompt.hidden({ message: "Code from the email" })).pipe(
        Effect.map(Redacted.value),
      ),
    }),
).pipe(
  Command.withDescription("Sign in with an emailed code and save an API key on this computer"),
);

const logoutCommand = Command.make("logout", {}, logout).pipe(
  Command.withDescription("Revoke this computer's API key and forget it"),
);

const vaultsCommand = Command.make("vaults", { json: jsonFlag }, listVaults).pipe(
  Command.withDescription("List your vaults (* marks the default)"),
);

const vaultUseCommand = Command.make(
  "use",
  { vault: Argument.string("vault").pipe(Argument.withDescription("Vault name or id")) },
  useVault,
).pipe(Command.withDescription("Set the default vault for later commands"));

const vaultCommand = Command.make("vault").pipe(
  Command.withDescription("Choose the default vault"),
  Command.withSubcommands([vaultUseCommand]),
);

const askCommand = Command.make(
  "ask",
  {
    question: Argument.string("question").pipe(Argument.withDescription("Your question")),
    session: Flag.string("session").pipe(
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

const updateCommand = Command.make("update", { vault: vaultFlag, json: jsonFlag }, update).pipe(
  Command.withDescription("Start an Update and follow it to the end"),
);

const runsCommand = Command.make(
  "runs",
  {
    vault: vaultFlag,
    limit: Flag.integer("limit").pipe(
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
    run: Argument.string("id").pipe(
      Argument.withSchema(Uuid),
      Argument.withDescription("Run id (from gm runs)"),
    ),
    vault: vaultFlag,
    json: jsonFlag,
  },
  followExistingRun,
).pipe(Command.withDescription("Follow a run until it ends and show what it changed"));

const gm = Command.make("gm").pipe(
  Command.withDescription("Great Minds from the command line"),
  Command.withSubcommands([
    loginCommand,
    logoutCommand,
    vaultsCommand,
    vaultCommand,
    askCommand,
    updateCommand,
    runsCommand,
    runCommand,
  ]),
);

export const runGm = (args: readonly string[], version: string) =>
  Command.runWith(gm, { version })(args);
