import type { PublicationPaper, SessionId } from "@great-minds/domain";
import { Data, Effect, Fiber } from "effect";

import { fork } from "$lib/api/app";
import { errorMessage } from "$lib/api/errors";
import { prepareSessionExport } from "$lib/api/sessions";
import { auth } from "$lib/auth.svelte";
import { activeVault } from "$lib/hooks/use-vault.svelte";

export interface PreparedExport {
  readonly title: string;
  readonly preparedAt: Date;
  readonly filename: string;
  readonly pdfUrl: string;
  readonly markdownUrl: string;
}

class DownloadUnavailable extends Data.TaggedError("DownloadUnavailable") {
  readonly message = "Couldn’t create this download in your browser.";
}

const objectUrl = (blob: Blob) =>
  Effect.acquireRelease(
    Effect.try({ try: () => URL.createObjectURL(blob), catch: () => new DownloadUnavailable() }),
    (url) => Effect.sync(() => URL.revokeObjectURL(url)),
  );

export function useSessionExport(sessionId: () => SessionId | null) {
  let open = $state(false);
  let pending = $state(false);
  let error = $state<string | null>(null);
  let paper = $state<PublicationPaper>("a4");
  let prepared = $state<PreparedExport | null>(null);
  let owner: Fiber.Fiber<void> | null = null;
  let revision = 0;

  function close() {
    revision += 1;
    if (owner !== null) fork(Fiber.interrupt(owner));
    owner = null;
    prepared = null;
    pending = false;
    error = null;
    open = false;
  }

  $effect(() => {
    sessionId();
    void activeVault.id;
    void auth.userId;
    return close;
  });

  function prepare() {
    const id = sessionId();
    const vaultId = activeVault.id;
    if (pending || id === null || vaultId === null) return;
    const previous = owner;
    const current = ++revision;
    const selectedPaper = paper;
    prepared = null;
    open = true;
    pending = true;
    error = null;
    const preparation = Effect.gen(function* () {
      if (previous !== null) yield* Fiber.interrupt(previous);
      const result = yield* prepareSessionExport(vaultId, id, selectedPaper);
      if (revision !== current) return;
      const filename =
        result.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/gu, "-")
          .replace(/^-+|-+$/gu, "")
          .slice(0, 60) || "conversation";
      const pdfUrl = yield* objectUrl(
        new Blob([new Uint8Array(result.pdf)], { type: "application/pdf" }),
      );
      const markdownUrl = yield* objectUrl(
        new Blob([result.markdown], { type: "text/markdown;charset=utf-8" }),
      );
      prepared = {
        title: result.title,
        preparedAt: result.prepared_at,
        filename,
        pdfUrl: `${pdfUrl}#view=FitH&navpanes=0`,
        markdownUrl,
      };
      pending = false;
      yield* Effect.never;
    });
    owner = fork(
      Effect.scoped(preparation).pipe(
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

  function changePaper(value: PublicationPaper) {
    if (pending || value === paper) return;
    paper = value;
    prepare();
  }

  return {
    get open() {
      return open;
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
    prepare,
    close,
    changePaper,
  };
}
