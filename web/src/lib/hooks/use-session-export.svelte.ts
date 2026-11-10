import {
  ServiceUnavailable,
  type PublicationPaper,
  type SessionExportMessage,
  type SessionId,
} from "@great-minds/domain";
import { Data, Effect, Fiber, type Scope } from "effect";

import { fork } from "#lib/api/app.ts";
import { errorMessage } from "@great-minds/client";
import { prepareSessionExport, readSession, readSessionMarkdown } from "#lib/api/sessions.ts";
import { auth } from "#lib/auth.svelte.ts";
import { activeVault } from "#lib/hooks/use-vault.svelte.ts";

export type ExportFormat = "pdf" | "markdown";
export type ExportMessage = {
  readonly message: SessionExportMessage;
  readonly text: string;
  readonly note: boolean;
  readonly selected: boolean;
};
export type PreparedExport = {
  readonly filename: string;
  readonly url: string;
};

class DownloadUnavailable extends Data.TaggedError("DownloadUnavailable") {
  readonly message = "Couldn’t start the download. Use the download button to try again.";
}

const objectUrl = (blob: Blob) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => URL.createObjectURL(blob),
      catch: () => new DownloadUnavailable(),
    }),
    (url) => Effect.sync(() => URL.revokeObjectURL(url)),
  );

const download = (url: string, filename: string) =>
  Effect.try({
    try: () => {
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.append(link);
      try {
        link.click();
      } finally {
        link.remove();
      }
    },
    catch: () => new DownloadUnavailable(),
  });

export function useSessionExport(sessionId: () => SessionId | null) {
  let view = $state<"closed" | "selection" | "preview">("closed");
  let pending = $state(false);
  let error = $state<string | null>(null);
  let paper = $state<PublicationPaper>("a4");
  let format = $state<ExportFormat>("pdf");
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
    view = "closed";
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
    view = "selection";
    messages = [];
    runTask(
      Effect.gen(function* () {
        const session = yield* readSession(vaultId, id);
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

  function prepare(action: "download" | "preview") {
    const id = sessionId();
    const vaultId = activeVault.id;
    const [first, ...rest] = messages.filter((entry) => entry.selected);
    if (pending || id === null || vaultId === null || first === undefined) return;
    if (action === "preview" && prepared) {
      view = "preview";
      return;
    }
    const selection = { messages: [first.message, ...rest.map((entry) => entry.message)] as const };
    const selectedPaper = paper;
    const selectedFormat = format;
    runTask(
      Effect.gen(function* () {
        const result =
          selectedFormat === "pdf"
            ? yield* prepareSessionExport(vaultId, id, { ...selection, paper: selectedPaper })
            : {
                title: "Conversation",
                markdown: yield* readSessionMarkdown(vaultId, id, selection),
                pdf: null,
              };
        const filename =
          result.title
            .toLowerCase()
            .replace(/[^a-z0-9]+/gu, "-")
            .replace(/^-+|-+$/gu, "")
            .slice(0, 60) || "conversation";
        const url = yield* objectUrl(
          result.pdf === null
            ? new Blob([result.markdown], { type: "text/markdown;charset=utf-8" })
            : new Blob([new Uint8Array(result.pdf)], { type: "application/pdf" }),
        );
        prepared = { filename, url };
        pending = false;
        if (action === "preview") view = "preview";
        else
          yield* download(url, `${filename}.${selectedFormat === "pdf" ? "pdf" : "md"}`).pipe(
            Effect.catch((cause) =>
              Effect.sync(() => {
                error = cause.message;
              }),
            ),
          );
        yield* Effect.never;
      }),
    );
  }

  return {
    get open() {
      return view !== "closed";
    },
    get previewing() {
      return view === "preview";
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
    get format() {
      return format;
    },
    get prepared() {
      return prepared;
    },
    get messages() {
      return messages;
    },
    begin,
    prepare,
    chooseMessages() {
      view = "selection";
    },
    select(index: number, selected: boolean) {
      if (pending) return;
      invalidate();
      messages = messages.map((entry, position) =>
        position === index ? { ...entry, selected } : entry,
      );
    },
    selectAll(selected: boolean) {
      if (pending) return;
      invalidate();
      messages = messages.map((entry) => ({ ...entry, selected }));
    },
    changePaper(value: PublicationPaper) {
      if (pending || value === paper) return;
      invalidate();
      paper = value;
    },
    changeFormat(value: ExportFormat) {
      if (pending || value === format) return;
      invalidate();
      format = value;
    },
    close,
  };
}
