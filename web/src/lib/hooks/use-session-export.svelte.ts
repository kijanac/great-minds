import {
  ServiceUnavailable,
  type PublicationPaper,
  type SessionExportMessage,
  type SessionId,
} from "@great-minds/domain";
import { Data, Effect, Fiber, type Scope } from "effect";

import { fork } from "#lib/api/app.ts";
import { errorMessage } from "@great-minds/client";
import {
  prepareSessionExport,
  readSessionForExport,
  readSessionMarkdown,
} from "#lib/api/sessions.ts";
import { auth } from "#lib/auth.svelte.ts";
import { activeVault } from "#lib/hooks/use-vault.svelte.ts";

export type ExportMessage = {
  readonly message: SessionExportMessage;
  readonly text: string;
  readonly note: boolean;
  readonly selected: boolean;
};

export type PreparedExport = {
  readonly filename: string;
  readonly markdownUrl: string;
} & (
  | {
      readonly format: "pdf";
      readonly title: string;
      readonly preparedAt: Date;
      readonly pdfUrl: string;
    }
  | { readonly format: "markdown" }
);

class DownloadUnavailable extends Data.TaggedError("DownloadUnavailable") {
  readonly message = "Couldn’t create this download in your browser.";
}

const objectUrl = (blob: Blob) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => URL.createObjectURL(blob),
      catch: () => new DownloadUnavailable(),
    }),
    (url) => Effect.sync(() => URL.revokeObjectURL(url)),
  );

export function useSessionExport(sessionId: () => SessionId | null) {
  let open = $state(false);
  let selecting = $state(true);
  let pending = $state(false);
  let error = $state<string | null>(null);
  let paper = $state<PublicationPaper>("a4");
  let prepared = $state<PreparedExport | null>(null);
  let messages = $state<ExportMessage[]>([]);
  let owner: Fiber.Fiber<void> | null = null;
  let revision = 0;

  function invalidate() {
    revision += 1;
    if (owner !== null) fork(Fiber.interrupt(owner));
    owner = null;
    prepared = null;
    pending = false;
    error = null;
  }

  function close() {
    invalidate();
    messages = [];
    open = false;
  }

  $effect(() => {
    sessionId();
    void activeVault.id;
    void auth.userId;
    return close;
  });

  function runTask<E>(task: Effect.Effect<void, E, Scope.Scope>) {
    invalidate();
    const current = revision;
    pending = true;
    owner = fork(
      Effect.scoped(task).pipe(
        Effect.catch((cause) =>
          Effect.sync(() => {
            if (revision === current) {
              error = errorMessage(cause, "Couldn’t prepare this export. Try again.");
              pending = false;
            }
          }),
        ),
      ),
    );
  }

  function begin() {
    const id = sessionId();
    const vaultId = activeVault.id;
    if (id === null || vaultId === null) return;
    open = true;
    selecting = true;
    messages = [];
    runTask(
      Effect.gen(function* () {
        const session = yield* readSessionForExport(vaultId, id);
        const sections = [{ id: session.id, events: session.events, note: false }];
        for (const thread of session.threads) {
          if (thread.availability === "unavailable")
            return yield* new ServiceUnavailable({
              detail: "An attached note could not be loaded. Try again before choosing messages.",
            });
          sections.push({ id: thread.session.id, events: thread.events, note: true });
        }
        messages = sections.flatMap((section) =>
          section.events.flatMap((event) =>
            event.type !== "exchange"
              ? []
              : (["user", "assistant"] as const).map((role) => ({
                  message: { session_id: section.id, exchange_id: event.exId, role },
                  text: role === "user" ? event.query : event.answer,
                  note: section.note,
                  selected: true,
                })),
          ),
        );
        pending = false;
      }),
    );
  }

  function prepare(format: "pdf" | "markdown") {
    const id = sessionId();
    const vaultId = activeVault.id;
    const [first, ...rest] = messages.filter((entry) => entry.selected);
    if (pending || id === null || vaultId === null || first === undefined) return;
    const selection = { messages: [first.message, ...rest.map((entry) => entry.message)] as const };
    const selectedPaper = paper;
    selecting = false;
    runTask(
      Effect.gen(function* () {
        const result =
          format === "pdf"
            ? yield* prepareSessionExport(vaultId, id, { ...selection, paper: selectedPaper }).pipe(
                Effect.map((value) => ({ ...value, format: "pdf" as const })),
              )
            : {
                format: "markdown" as const,
                markdown: yield* readSessionMarkdown(vaultId, id, selection),
              };
        const markdownUrl = yield* objectUrl(
          new Blob([result.markdown], { type: "text/markdown;charset=utf-8" }),
        );
        if (result.format === "pdf") {
          const filename =
            result.title
              .toLowerCase()
              .replace(/[^a-z0-9]+/gu, "-")
              .replace(/^-+|-+$/gu, "")
              .slice(0, 60) || "conversation";
          const pdfUrl = yield* objectUrl(
            new Blob([new Uint8Array(result.pdf)], { type: "application/pdf" }),
          );
          prepared = {
            format: "pdf",
            title: result.title,
            preparedAt: result.prepared_at,
            filename,
            pdfUrl: `${pdfUrl}#view=FitH&navpanes=0`,
            markdownUrl,
          };
        } else prepared = { format: "markdown", filename: "conversation", markdownUrl };
        pending = false;
        yield* Effect.never;
      }),
    );
  }

  function changePaper(value: PublicationPaper) {
    if (pending || value === paper) return;
    paper = value;
    if (!selecting) prepare("pdf");
  }

  return {
    get open() {
      return open;
    },
    get selecting() {
      return selecting;
    },
    get pending() {
      return pending;
    },
    get error() {
      return error;
    },
    get paper() {
      return paper;
    },
    get prepared() {
      return prepared;
    },
    get messages() {
      return messages;
    },
    begin,
    chooseMessages() {
      invalidate();
      selecting = true;
    },
    select(index: number, selected: boolean) {
      messages = messages.map((entry, position) =>
        position === index ? { ...entry, selected } : entry,
      );
    },
    selectAll(selected: boolean) {
      messages = messages.map((entry) => ({ ...entry, selected }));
    },
    prepare: () => prepare("pdf"),
    prepareMarkdown: () => prepare("markdown"),
    close,
    changePaper,
  };
}
