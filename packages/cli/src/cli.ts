import {
  PublicationPaper,
  SearchQuery,
  SessionExportSelection,
  SessionId,
  Uuid,
} from "@great-minds/domain";
import { Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import {
  add,
  callApi,
  exportSession,
  listSessions,
  listSources,
  listArticles,
  search,
  readChunks,
  readLinks,
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

const offsetFlag = Flag.Int("offset").pipe(
  Flag.filter(
    (offset) => offset >= 0,
    (offset) => `--offset can't be negative (got ${offset})`,
  ),
  Flag.withDescription("Skip this many results"),
  Flag.withDefault(0),
);

const sourcesCommand = Command.make(
  "sources",
  {
    vault: vaultFlag,
    tags: Flag.String("tag").pipe(
      Flag.withDescription("Only sources with this tag (repeat for several)"),
      Flag.atLeast(0),
    ),
    author: Flag.String("author").pipe(
      Flag.withDescription("Part of the author's name"),
      Flag.optional,
    ),
    genre: Flag.String("genre").pipe(Flag.withDescription("The exact genre"), Flag.optional),
    from: Flag.String("from").pipe(
      Flag.withDescription("Published on or after: YYYY, YYYY-MM or YYYY-MM-DD"),
      Flag.optional,
    ),
    to: Flag.String("to").pipe(
      Flag.withDescription("Published on or before: YYYY, YYYY-MM or YYYY-MM-DD"),
      Flag.optional,
    ),
    fields: Flag.KeyValuePair("field").pipe(
      Flag.withDescription("One of the vault's own metadata fields, name=value (repeatable)"),
      Flag.optional,
    ),
    sort: Flag.Literals("sort", ["date", "date_desc", "title"]).pipe(
      Flag.withDescription("date (oldest first), date_desc or title"),
      Flag.withDefault("date" as const),
    ),
    limit: limitFlag,
    offset: offsetFlag,
    json: jsonFlag,
  },
  listSources,
).pipe(Command.withDescription("Filter the vault's sources by their metadata"));

const sessionsCommand = Command.make(
  "sessions",
  { vault: vaultFlag, limit: limitFlag, offset: offsetFlag, json: jsonFlag },
  listSessions,
).pipe(Command.withDescription("List recent sessions, newest first"));

const sessionArgument = Argument.String("id").pipe(
  Argument.withSchema(SessionId),
  Argument.withDescription("Session id (from gm sessions or gm ask)"),
);

const sessionCommand = Command.make(
  "session",
  {
    session: sessionArgument,
    vault: vaultFlag,
    json: jsonFlag,
  },
  readSession,
).pipe(Command.withDescription("Print a session as markdown"));

const exportCommand = Command.make(
  "export",
  {
    session: sessionArgument,
    vault: vaultFlag,
    format: Flag.Literals("format", ["pdf", "markdown"]).pipe(Flag.withDefault("pdf" as const)),
    paper: Flag.Literals("paper", PublicationPaper.literals).pipe(
      Flag.withDescription("PDF paper size (default: a4; ignored for Markdown)"),
      Flag.withDefault("a4" as const),
    ),
    messages: Flag.String("messages").pipe(
      Flag.withSchema(Schema.fromJsonString(SessionExportSelection.fields.messages)),
      Flag.withDescription(
        "JSON array of {session_id, exchange_id, role}; omit for all messages. IDs: gm session <id> --json",
      ),
      Flag.optional,
    ),
    output: Flag.Path("output").pipe(
      Flag.withDescription("New file to save; existing files are never overwritten"),
    ),
    json: jsonFlag,
  },
  exportSession,
).pipe(
  Command.withDescription(
    "Save a conversation or selected messages as PDF or Markdown (default: PDF)",
  ),
);

const searchCommand = Command.make(
  "search",
  {
    query: Argument.String("query").pipe(Argument.withSchema(SearchQuery.fields.q)),
    path: Flag.String("path").pipe(
      Flag.withDescription("Search only this document"),
      Flag.optional,
    ),
    vault: vaultFlag,
    json: jsonFlag,
  },
  search,
).pipe(Command.withDescription("Search sources and wiki articles for relevant passages"));

const articlesCommand = Command.make(
  "articles",
  {
    vault: vaultFlag,
    contains: Flag.String("contains").pipe(
      Flag.withDescription("Text in the title or summary"),
      Flag.optional,
    ),
    tag: Flag.String("tag").pipe(Flag.withDescription("Article tag"), Flag.optional),
    run: Flag.String("run").pipe(
      Flag.withSchema(Uuid),
      Flag.withDescription("Articles written by this Update id"),
      Flag.optional,
    ),
    sort: Flag.Literals("sort", ["title", "linked", "recent"]).pipe(
      Flag.withDescription("Article order; recent cannot be combined with filters"),
      Flag.withDefault("title" as const),
    ),
    limit: limitFlag,
    offset: offsetFlag,
    json: jsonFlag,
  },
  listArticles,
).pipe(Command.withDescription("Browse wiki articles by title, tag or Update"));

const chunksCommand = Command.make(
  "chunks",
  {
    path: Argument.String("path"),
    start: Flag.Int("start"),
    end: Flag.Int("end"),
    vault: vaultFlag,
    json: jsonFlag,
  },
  readChunks,
).pipe(Command.withDescription("Read an inclusive range of indexed document chunks (up to 100)"));

const linksCommand = Command.make(
  "links",
  { path: Argument.String("path"), vault: vaultFlag, json: jsonFlag },
  readLinks,
).pipe(Command.withDescription("Read an article's outgoing, incoming and related links"));

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
    sourcesCommand,
    sessionsCommand,
    sessionCommand,
    exportCommand,
    searchCommand,
    articlesCommand,
    chunksCommand,
    linksCommand,
    readCommand,
    apiCommand,
  ]),
);

export const runGm = (args: readonly string[], version: string) =>
  Command.runWith(gm, { version })(args);
