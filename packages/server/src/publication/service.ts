import type {
  Conflict,
  Forbidden,
  NotFound,
  ServiceUnavailable,
  SessionExport,
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

type ExportError = Conflict | Forbidden | NotFound | ServiceUnavailable;
export interface SessionExportsServiceShape {
  readonly readMarkdown: (
    userId: Uuid,
    vaultId: Uuid,
    sessionId: SessionId,
  ) => Effect.Effect<string, ExportError>;
  readonly prepare: (
    userId: Uuid,
    vaultId: Uuid,
    sessionId: SessionId,
    request: SessionExportRequest,
  ) => Effect.Effect<SessionExport, ExportError>;
}

export class SessionExportsService extends Context.Service<
  SessionExportsService,
  SessionExportsServiceShape
>()("@great-minds/server/SessionExportsService") {}

const makeSessionExports = Effect.gen(function* () {
  const sessions = yield* SessionsService;
  const config = yield* AppConfig;
  const clock = yield* ClockService;
  const renderer = yield* PdfRenderer;
  const read = (userId: Uuid, vaultId: Uuid, sessionId: SessionId) =>
    Effect.gen(function* () {
      const session = yield* sessions.readSession(userId, vaultId, sessionId);
      return yield* prepareSessionPublication(session, { webUrl: config.publicWebUrl, vaultId });
    });
  return {
    readMarkdown: (userId: Uuid, vaultId: Uuid, sessionId: SessionId) =>
      read(userId, vaultId, sessionId).pipe(Effect.map((publication) => publication.markdown)),
    prepare: (userId: Uuid, vaultId: Uuid, sessionId: SessionId, request: SessionExportRequest) =>
      Effect.gen(function* () {
        const publication = yield* read(userId, vaultId, sessionId);
        const preparedAt = yield* clock.now;
        const pdf = yield* renderer.render(publication, request.paper, preparedAt);
        return {
          title: publication.title,
          prepared_at: preparedAt,
          paper: request.paper,
          markdown: publication.markdown,
          pdf,
        };
      }),
  } satisfies SessionExportsServiceShape;
});
export const SessionExportsServiceLive = Layer.effect(SessionExportsService, makeSessionExports);
