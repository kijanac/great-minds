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
type PreparedExport = {
  readonly filename: string;
  readonly url: string;
  readonly autoDownload: boolean;
};

class DownloadUnavailable extends Data.TaggedError("DownloadUnavailable") {
  readonly message = "Couldn’t create this download. Try again.";
}

const objectUrl = (blob: Blob) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => URL.createObjectURL(blob),
      catch: () => new DownloadUnavailable(),
    }),
    (url) => Effect.sync(() => URL.revokeObjectURL(url)),
  );

export class SessionExport {
  private view = $state<"closed" | "selection" | "preview">("closed");
  readonly open = $derived(this.view !== "closed");
  readonly previewing = $derived(this.view === "preview");
  pending = $state(false);
  error = $state<string | null>(null);
  paper = $state<PublicationPaper>("a4");
  format = $state<ExportFormat>("pdf");
  prepared = $state<PreparedExport | null>(null);
  messages = $state<ExportMessage[]>([]);
  private owner: Fiber.Fiber<void> | null = null;
  private revision = 0;

  constructor(private readonly sessionId: () => SessionId | null) {
    $effect(() => {
      sessionId();
      void activeVault.id;
      void auth.userId;
      return this.close;
    });
  }

  private invalidate() {
    this.revision += 1;
    if (this.owner !== null) fork(Fiber.interrupt(this.owner));
    this.owner = null;
    this.prepared = null;
    this.pending = false;
    this.error = null;
  }

  close = () => {
    this.invalidate();
    this.messages = [];
    this.view = "closed";
  };

  private runTask<E>(task: Effect.Effect<void, E, Scope.Scope>) {
    this.invalidate();
    const current = this.revision;
    this.pending = true;
    this.owner = fork(
      Effect.scoped(task).pipe(
        Effect.catch((cause) =>
          Effect.sync(() => {
            if (this.revision === current) {
              this.error = errorMessage(cause, "Couldn’t prepare this export. Try again.");
              this.pending = false;
            }
          }),
        ),
      ),
    );
  }

  begin = () => {
    const id = this.sessionId();
    const vaultId = activeVault.id;
    if (id === null || vaultId === null) return;
    this.view = "selection";
    this.messages = [];
    this.runTask(
      Effect.gen({ self: this }, function* () {
        const session = yield* readSession(vaultId, id);
        const sections = [{ id: session.id, events: session.events, note: false }];
        for (const thread of session.threads) {
          if (thread.availability === "unavailable")
            return yield* new ServiceUnavailable({
              detail: "An attached note could not be loaded. Try again before choosing messages.",
            });
          sections.push({ id: thread.session.id, events: thread.events, note: true });
        }
        this.messages = sections.flatMap((section) =>
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
        this.pending = false;
      }),
    );
  };

  prepare = (action: "download" | "preview") => {
    const id = this.sessionId();
    const vaultId = activeVault.id;
    const [first, ...rest] = this.messages.filter((entry) => entry.selected);
    if (this.pending || id === null || vaultId === null || first === undefined) return;
    if (action === "preview" && this.prepared) {
      this.view = "preview";
      return;
    }
    const selection = { messages: [first.message, ...rest.map((entry) => entry.message)] as const };
    const paper = this.paper;
    const format = this.format;
    this.runTask(
      Effect.gen({ self: this }, function* () {
        const result =
          format === "pdf"
            ? yield* prepareSessionExport(vaultId, id, { ...selection, paper })
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
        this.prepared = {
          filename: `${filename}.${format === "pdf" ? "pdf" : "md"}`,
          url,
          autoDownload: action === "download",
        };
        this.pending = false;
        if (action === "preview") this.view = "preview";
        yield* Effect.never;
      }),
    );
  };

  chooseMessages = () => {
    this.view = "selection";
  };

  select = (target: number | "all", selected: boolean) => {
    if (this.pending) return;
    this.invalidate();
    this.messages = this.messages.map((entry, position) =>
      target === "all" || position === target ? { ...entry, selected } : entry,
    );
  };

  changePaper = (value: PublicationPaper) => {
    if (this.pending || value === this.paper) return;
    this.invalidate();
    this.paper = value;
  };

  changeFormat = (value: ExportFormat) => {
    if (this.pending || value === this.format) return;
    this.invalidate();
    this.format = value;
  };
}
