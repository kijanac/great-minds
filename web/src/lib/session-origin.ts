import type { SessionId, SessionOrigin } from "@great-minds/domain";

export const sessionOriginHref = (origin: SessionOrigin, conversationId: SessionId): string => {
  const path =
    origin.kind === "answer"
      ? `/sessions/${origin.session_id}`
      : `${origin.origin_scope === "personal" ? "/refs/" : "/doc/"}${origin.doc_path}`;
  return origin.anchor ? `${path}?thread=${encodeURIComponent(conversationId)}` : path;
};
