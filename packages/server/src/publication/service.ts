import type {
  Conflict,
  Forbidden,
  NotFound,
  ServiceUnavailable,
  SessionExportRequest,
  SessionId,
  Uuid,
} from "@great-minds/domain";
import { Context, Effect, Layer } from "effect";

import { ClockService } from "../clock.ts";
import { AppConfig } from "../config.ts";
import { SessionsService } from "../sessions.ts";
import { prepareSessionPublication } from "./markdown.ts";
import { PdfRenderer } from "./pdf.ts";

export type SessionExportFile = { readonly filename: string } & (
  | { readonly format: "markdown"; readonly markdown: string }
  | { readonly format: "pdf"; readonly pdf: Uint8Array }
);

export interface SessionExportsServiceShape {
  readonly export: (
    userId: Uuid,
    vaultId: Uuid,
    sessionId: SessionId,
    request: SessionExportRequest,
  ) => Effect.Effect<SessionExportFile, Conflict | Forbidden | NotFound | ServiceUnavailable>;
}

export class SessionExportsService extends Context.Service<
  SessionExportsService,
  SessionExportsServiceShape
>()("@great-minds/server/SessionExportsService") {}

const filenameOf = (title: string, extension: string) =>
  `${
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 60) || "conversation"
  }.${extension}`;

const makeSessionExports = Effect.gen(function* () {
  const sessions = yield* SessionsService;
  const config = yield* AppConfig;
  const clock = yield* ClockService;
  const renderer = yield* PdfRenderer;
  return {
    export: (userId, vaultId, sessionId, request) =>
      Effect.gen(function* () {
        const publication = yield* prepareSessionPublication(
          yield* sessions.readSession(userId, vaultId, sessionId),
          { webUrl: config.publicWebUrl, vaultId },
          request,
        );
        if (request.format === "markdown")
          return {
            format: "markdown" as const,
            filename: filenameOf(publication.title, "md"),
            markdown: publication.markdown,
          };
        return {
          format: "pdf" as const,
          filename: filenameOf(publication.title, "pdf"),
          pdf: yield* renderer.render(publication, request.paper ?? "a4", yield* clock.now),
        };
      }),
  } satisfies SessionExportsServiceShape;
});
export const SessionExportsServiceLive = Layer.effect(SessionExportsService, makeSessionExports);
