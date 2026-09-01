import {
  SessionId,
  Uuid,
  type OriginScope,
  type OriginSessionDetail,
  type PromoteExchangeResponse,
  type SessionEvent,
  type SessionOrigin,
  type SessionOverview,
  type SessionPage,
  type SessionResponse,
} from "@great-minds/domain";
import { Schema } from "effect";

import { getVaultId } from "$lib/vault-selection";

import { api, run } from "./app";

export type { OriginScope, SessionEvent, SessionOrigin };
export type SessionSummary = SessionOverview;

const uuid = Schema.decodeSync(Uuid);
const parseSessionId = Schema.decodeSync(SessionId);
const firstPage = { limit: 50, offset: 0 } as const;

function selectedVault(): Uuid {
  const id = getVaultId();
  if (id === null) throw new Error("No vault selected");
  return uuid(id);
}

export async function listSessions(
  params: { limit: number; offset: number } = firstPage,
): Promise<SessionPage> {
  return run(api.sessions.listSessions({ params: { vault_id: selectedVault() }, query: params }));
}

export async function listSessionsByOrigin(
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

export async function loadSession(sessionId: string): Promise<SessionResponse> {
  return run(
    api.sessions.readSession({
      params: { vault_id: selectedVault(), session_id: parseSessionId(sessionId) },
    }),
  );
}

export async function loadSessionMarkdown(sessionId: string): Promise<string> {
  return run(
    api.sessions.readSessionMarkdown({
      params: { vault_id: selectedVault(), session_id: parseSessionId(sessionId) },
    }),
  );
}

export async function promoteExchange(
  sessionId: string,
  exchangeId: string,
): Promise<PromoteExchangeResponse> {
  return run(
    api.sessions.promoteSessionExchange({
      params: {
        vault_id: selectedVault(),
        session_id: parseSessionId(sessionId),
        exchange_id: exchangeId,
      },
    }),
  );
}
