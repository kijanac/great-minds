import {
  PageParamsQuery,
  PipelineRunFilter,
  ProposalStatus,
  ProposalUpdate,
  PublicationPaper,
  RawSource,
  SearchQuery,
  SourceQuery,
  SessionExportSelection,
  SessionId,
  Uuid,
} from "@great-minds/domain";
import { Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import {
  add,
  addUrl,
  ingestText,
  listReferences,
  reference,
  promoteReference,
  source,
  listProposals,
  proposal,
  createProposal,
  submitSuggestion,
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
  cancelRun,
  retryRun,
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
const vaultFlags = { vault: vaultFlag, json: jsonFlag };
const pageFlags = {
  ...vaultFlags,
  limit: Flag.Int("limit").pipe(
    Flag.withSchema(Schema.toType(SourceQuery.fields.limit)),
    Flag.withDescription("How many to list (1-200)"),
    Flag.withDefault(20),
  ),
  offset: Flag.Int("offset").pipe(
    Flag.withSchema(Schema.toType(PageParamsQuery.fields.offset)),
    Flag.withDescription("Skip this many results"),
    Flag.withDefault(0),
  ),
};
const idArgument = Argument.String("id").pipe(Argument.withSchema(Uuid));
const sourceFlags = { ...vaultFlags, source_id: idArgument };
const proposalFlags = { ...vaultFlags, proposal_id: idArgument };
const sessionArgument = Argument.String("id").pipe(
  Argument.withSchema(SessionId),
  Argument.withDescription("Session id (from gm sessions or gm ask)"),
);
const jobIdFlag = Flag.String("job-id").pipe(
  Flag.withSchema(Uuid),
  Flag.withDescription("New UUID; reuse for this same request after a lost response"),
  Flag.optional,
);

const gm = Command.make("gm").pipe(
  Command.withDescription("Great Minds from the command line"),
  Command.withSubcommands([
    Command.make(
      "login",
      {
        url: Flag.String("url").pipe(Flag.withDescription("API base URL"), Flag.optional),
      },
      login,
    ).pipe(
      Command.withDescription(
        "Sign in by approving this computer in your browser; saves an API key",
      ),
    ),
    Command.make("logout", {}, logout).pipe(
      Command.withDescription("Revoke this computer's API key and forget it"),
    ),
    Command.make("vaults", { json: jsonFlag }, listVaults).pipe(
      Command.withDescription("List your vaults (* marks the default)"),
    ),
    Command.make("vault").pipe(
      Command.withDescription("Choose the default vault"),
      Command.withSubcommands([
        Command.make(
          "use",
          {
            vault: Argument.String("vault").pipe(Argument.withDescription("Vault name or id")),
          },
          useVault,
        ).pipe(Command.withDescription("Set the default vault for later commands")),
      ]),
    ),
    Command.make(
      "ask",
      {
        question: Argument.String("question").pipe(Argument.withDescription("Your question")),
        session: Flag.String("session").pipe(
          Flag.withSchema(SessionId),
          Flag.withDescription("Continue an earlier session (its id is printed after each answer)"),
          Flag.optional,
        ),
        ...vaultFlags,
      },
      ask,
    ).pipe(
      Command.withDescription(
        "Ask the vault a question; shows the agent's steps as it works, then the answer and its sources",
      ),
    ),
    Command.make(
      "add",
      {
        paths: Argument.Path("path", { mustExist: true }).pipe(
          Argument.withDescription("Files or folders to add (folders are read recursively)"),
          Argument.atLeast(1),
        ),
        ...vaultFlags,
      },
      add,
    ).pipe(
      Command.withDescription(
        "Upload documents, skipping ones already in the vault, and follow the run they start",
      ),
    ),
    Command.make(
      "add-url",
      {
        url: Argument.String("url"),
        jobId: jobIdFlag,
        origin: Flag.String("origin").pipe(Flag.optional),
        ...vaultFlags,
      },
      addUrl,
    ).pipe(
      Command.withDescription("Import a public URL into a vault and follow the resulting job"),
    ),
    Command.make(
      "ingest",
      {
        file: Argument.Path("file", { mustExist: true }),
        dest: Flag.String("dest").pipe(
          Flag.withSchema(RawSource.fields.dest),
          Flag.withDescription("raw/ Markdown path; the server appends a UUID"),
        ),
        origin: Flag.String("origin").pipe(Flag.optional),
        ...vaultFlags,
      },
      ingestText,
    ).pipe(
      Command.withDescription(
        "Import Markdown directly from a file as a new source and queue an Update",
      ),
    ),
    Command.make(
      "references",
      {
        limit: pageFlags.limit,
        offset: pageFlags.offset,
        json: jsonFlag,
      },
      listReferences,
    ).pipe(Command.withDescription("List personal Reading Room references")),
    Command.make("reference").pipe(
      Command.withDescription("Save, read and manage personal Reading Room references"),
      Command.withSubcommands([
        Command.make("save", { url: Argument.String("url"), json: jsonFlag }, (input) =>
          reference({ ...input, action: "save" }),
        ).pipe(Command.withDescription("Save a public URL without adding it to a vault")),
        Command.make("read", { path: Argument.String("path"), json: jsonFlag }, (input) =>
          reference({ ...input, action: "read" }),
        ).pipe(Command.withDescription("Read a refs/ document")),
        Command.make(
          "rename",
          {
            reference_id: idArgument,
            title: Argument.String("title"),
            json: jsonFlag,
          },
          (input) => reference({ ...input, title: input.title || null, action: "rename" }),
        ).pipe(Command.withDescription("Change the title; an empty title clears it")),
        Command.make("delete", { reference_id: idArgument, json: jsonFlag }, (input) =>
          reference({ ...input, action: "delete" }),
        ).pipe(Command.withDescription("Permanently delete a personal reference")),
        Command.make(
          "promote",
          { path: Argument.String("path"), ...vaultFlags },
          promoteReference,
        ).pipe(Command.withDescription("Add a refs/ document to a vault and queue an Update")),
      ]),
    ),
    Command.make("update", vaultFlags, update).pipe(
      Command.withDescription("Start an Update and follow it to the end"),
    ),
    Command.make(
      "runs",
      {
        ...pageFlags,
        status: Flag.Literals("status", PipelineRunFilter.literals).pipe(
          Flag.withDescription("Only this status, or active"),
          Flag.optional,
        ),
      },
      listRuns,
    ).pipe(Command.withDescription("List recent Updates and uploads")),
    Command.make(
      "run",
      {
        run: idArgument,
        once: Flag.Boolean("once").pipe(
          Flag.withDescription("Read the current status without waiting"),
          Flag.withDefault(false),
        ),
        ...vaultFlags,
      },
      followExistingRun,
    ).pipe(Command.withDescription("Follow a run until it ends and show what it changed")),
    Command.make("cancel", { run: idArgument, ...vaultFlags }, cancelRun).pipe(
      Command.withDescription("Request cancellation of an Update or upload (owner only)"),
    ),
    Command.make("retry", { run: idArgument, jobId: jobIdFlag, ...vaultFlags }, retryRun).pipe(
      Command.withDescription("Retry a failed or cancelled URL import and follow it (owner only)"),
    ),
    Command.make(
      "sources",
      {
        ...pageFlags,
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
      },
      listSources,
    ).pipe(Command.withDescription("Filter the vault's sources by their metadata")),
    Command.make("source").pipe(
      Command.withDescription("Read or remove a vault source by id"),
      Command.withSubcommands([
        Command.make("read", sourceFlags, (input) => source({ ...input, action: "read" })).pipe(
          Command.withDescription("Read the source body"),
        ),
        Command.make("delete", sourceFlags, (input) => source({ ...input, action: "delete" })).pipe(
          Command.withDescription(
            "Permanently delete a source (owner only); does not run an Update",
          ),
        ),
        Command.make("request-deletion", sourceFlags, (input) =>
          source({ ...input, action: "request-deletion" }),
        ).pipe(Command.withDescription("Ask the owner to delete a source (editors only)")),
      ]),
    ),
    Command.make(
      "proposals",
      {
        ...pageFlags,
        status: Flag.Literals("status", ProposalStatus.literals).pipe(Flag.optional),
      },
      listProposals,
    ).pipe(Command.withDescription("List source proposals and their application status")),
    Command.make("proposal").pipe(
      Command.withDescription("Create, read or review a source proposal"),
      Command.withSubcommands([
        Command.make("read", proposalFlags, (input) => proposal({ ...input, action: "read" })),
        Command.make(
          "review",
          {
            ...proposalFlags,
            status: Argument.Literals("decision", ProposalUpdate.fields.status.literals),
          },
          (input) => proposal({ ...input, action: "review" }),
        ).pipe(
          Command.withDescription(
            "Approve or reject a proposal (owner only); application may still be pending",
          ),
        ),
        Command.make(
          "create",
          {
            ...vaultFlags,
            file: Argument.Path("file", { mustExist: true }),
            title: Flag.String("title").pipe(Flag.optional),
            author: Flag.String("author").pipe(Flag.optional),
            contentType: Flag.String("content-type").pipe(Flag.optional),
          },
          createProposal,
        ).pipe(
          Command.withDescription("Propose Markdown from a file; each call creates a new proposal"),
        ),
      ]),
    ),
    Command.make(
      "suggest",
      {
        ...vaultFlags,
        file: Argument.Path("file", { mustExist: true }),
        anchored_to: Flag.String("anchor").pipe(
          Flag.withDescription("Document path this suggestion concerns"),
          Flag.withDefault(""),
        ),
        anchored_section: Flag.String("passage").pipe(
          Flag.withDescription("Original passage to quote"),
          Flag.withDefault(""),
        ),
      },
      submitSuggestion,
    ).pipe(
      Command.withDescription(
        "Submit a note or correction; owners add it directly, editors propose it",
      ),
    ),
    Command.make("sessions", pageFlags, listSessions).pipe(
      Command.withDescription("List recent sessions, newest first"),
    ),
    Command.make("session", { session: sessionArgument, ...vaultFlags }, readSession).pipe(
      Command.withDescription("Print a session as markdown"),
    ),
    Command.make(
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
    ),
    Command.make(
      "search",
      {
        query: Argument.String("query").pipe(Argument.withSchema(SearchQuery.fields.q)),
        path: Flag.String("path").pipe(
          Flag.withDescription("Search only this document"),
          Flag.optional,
        ),
        ...vaultFlags,
      },
      search,
    ).pipe(Command.withDescription("Search sources and wiki articles for relevant passages")),
    Command.make(
      "articles",
      {
        ...pageFlags,
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
      },
      listArticles,
    ).pipe(Command.withDescription("Browse wiki articles by title, tag or Update")),
    Command.make(
      "chunks",
      {
        path: Argument.String("path"),
        start: Flag.Int("start"),
        end: Flag.Int("end"),
        ...vaultFlags,
      },
      readChunks,
    ).pipe(
      Command.withDescription("Read an inclusive range of indexed document chunks (up to 100)"),
    ),
    Command.make("links", { path: Argument.String("path"), ...vaultFlags }, readLinks).pipe(
      Command.withDescription("Read an article's outgoing, incoming and related links"),
    ),
    Command.make(
      "read",
      {
        path: Argument.String("path").pipe(
          Argument.withDescription("Document path, e.g. wiki/liquidationism.md or raw/docs/…md"),
        ),
        ...vaultFlags,
      },
      readDocument,
    ).pipe(Command.withDescription("Print an article or source")),
    Command.make(
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
    ).pipe(Command.withDescription("Call any API endpoint with your key and print the response")),
  ]),
);

export const runGm = (args: readonly string[], version: string) =>
  Command.runWith(gm, { version })(args);
