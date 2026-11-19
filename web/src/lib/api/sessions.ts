import {
  type OriginScope,
  type PromoteExchangeResponse,
  type SessionDetail,
  type SessionExportRequest,
  type SessionOrigin,
  type SessionOverview,
  type SessionPage,
  type SessionResponse,
  type SessionId,
  type Uuid,
} from "@great-minds/domain";

import { api, run } from "./app";
import { selectedVault } from "./selected-vault";
import { exportSession as exportSessionFile, withApiErrors } from "@great-minds/client";

export type { OriginScope, SessionOrigin };
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
): Promise<readonly SessionDetail[]> {
  return run(
    api.sessions.listSessionsByOrigin({
      params: { vault_id: selectedVault() },
      query: { doc_path: docPath },
    }),
    { signal },
  );
}

export function loadSession(sessionId: SessionId): Promise<SessionResponse> {
  return run(readSession(selectedVault(), sessionId));
}

export function readSession(vaultId: Uuid, sessionId: SessionId) {
  return withApiErrors(
    api.sessions.readSession({ params: { vault_id: vaultId, session_id: sessionId } }),
  );
}

export function exportSession(vaultId: Uuid, sessionId: SessionId, payload: SessionExportRequest) {
  return withApiErrors(exportSessionFile(api, vaultId, sessionId, payload));
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
