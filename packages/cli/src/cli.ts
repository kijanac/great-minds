import { Effect } from "effect";
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
  Flag.withDescription("Print the API's own response as JSON"),
  Flag.withDefault(false),
);

const loginCommand = Command.make(
  "login",
  {
    email: Argument.string("email").pipe(Argument.withDescription("Your account's email address")),
    url: Flag.string("url").pipe(Flag.withDescription("API base URL"), Flag.optional),
  },
  (input) =>
    login({
      email: input.email,
      url: input.url,
      readCode: Prompt.run(Prompt.text({ message: "Code from the email" })),
    }),
).pipe(
  Command.withDescription("Sign in with an emailed code and save an API key on this computer"),
);

const logoutCommand = Command.make("logout", {}, () => logout).pipe(
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
      Flag.withDescription("Continue an earlier session (its id is printed after each answer)"),
      Flag.optional,
    ),
    vault: vaultFlag,
    json: jsonFlag,
  },
  ask,
).pipe(Command.withDescription("Ask the vault a question; the answer streams in as it is written"));

const updateCommand = Command.make("update", { vault: vaultFlag, json: jsonFlag }, update).pipe(
  Command.withDescription("Start an Update and follow it to the end"),
);

const runsCommand = Command.make(
  "runs",
  {
    vault: vaultFlag,
    limit: Flag.integer("limit").pipe(Flag.withDefault(20)),
    json: jsonFlag,
  },
  listRuns,
).pipe(Command.withDescription("List recent Updates and uploads"));

const runCommand = Command.make(
  "run",
  {
    run: Argument.string("id").pipe(Argument.withDescription("Run id (from gm runs)")),
    vault: vaultFlag,
    json: jsonFlag,
  },
  followExistingRun,
).pipe(Command.withDescription("Follow a run until it ends and show what it changed"));

export const gm = Command.make("gm").pipe(
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

export const cliVersion = "0.1.0";

export const runGm = (args: readonly string[]) =>
  Command.runWith(gm, { version: cliVersion })(args).pipe(Effect.asVoid);
