import {
  type OriginScope,
  type OriginSessionDetail,
  type PromoteExchangeResponse,
  type PublicationPaper,
  type SessionEvent,
  type SessionOrigin,
  type SessionOverview,
  type SessionPage,
  type SessionResponse,
  type SessionId,
  type Uuid,
} from "@great-minds/domain";

import { api, run } from "./app";
import { selectedVault } from "./selected-vault";
import { withApiErrors } from "./runtime";

export type { OriginScope, SessionEvent, SessionOrigin };
export type SessionSummary = SessionOverview;

const firstPage = { limit: 50, offset: 0 } as const;

export function listSessions(
  params: { limit: number; offset: number } = firstPage,
): Promise<SessionPage> {
  return run(api.sessions.listSessions({ params: { vault_id: selectedVault() }, query: params }));
}

export function listSessionsByOrigin(
  docPath: string,
  signal?: AbortSignal,
): Promise<readonly OriginSessionDetail[]> {
  return run(
    api.sessions.listSessionsByOrigin({
      params: { vault_id: selectedVault() },
      query: { doc_path: docPath },
    }),
    { signal },
  );
}

export function loadSession(sessionId: SessionId): Promise<SessionResponse> {
  return run(
    api.sessions.readSession({
      params: { vault_id: selectedVault(), session_id: sessionId },
    }),
  );
}

export function continueAsSession(sessionId: SessionId): Promise<void> {
  return run(
    api.sessions.continueAsSession({
      params: { vault_id: selectedVault(), session_id: sessionId },
    }),
  );
}

export function prepareSessionExport(vaultId: Uuid, sessionId: SessionId, paper: PublicationPaper) {
  return withApiErrors(
    api.sessions.prepareSessionExport({
      params: { vault_id: vaultId, session_id: sessionId },
      payload: { paper },
    }),
  );
}

export function promoteExchange(
  sessionId: SessionId,
  exchangeId: Uuid,
): Promise<PromoteExchangeResponse> {
  return run(
    api.sessions.promoteSessionExchange({
      params: {
        vault_id: selectedVault(),
        session_id: sessionId,
        exchange_id: exchangeId,
      },
    }),
  );
}
