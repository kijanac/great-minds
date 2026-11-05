import {
  JobProgressSnapshot,
  ReplySnapshot,
  isReplyPending,
  type Uuid,
  type Vault,
} from "@great-minds/domain";
import { Effect, Stream } from "effect";

import type { Api } from "./runtime.ts";
import { followSnapshots } from "./sse.ts";

const VAULT_PAGE = 50;

export const jobFinished = (snapshot: JobProgressSnapshot) =>
  (snapshot.job_status !== "pending" && snapshot.job_status !== "running") ||
  snapshot.phase_status === "failed" ||
  (snapshot.phase === "publish" && snapshot.phase_status === "completed");

export const followJob = (api: Api, vaultId: Uuid, jobId: Uuid) =>
  followSnapshots(
    Stream.unwrap(api.jobs.streamJob({ params: { vault_id: vaultId, job_id: jobId } })),
    JobProgressSnapshot,
    jobFinished,
  );

export const followReply = (api: Api, vaultId: Uuid, replyId: Uuid) =>
  followSnapshots(
    Stream.unwrap(api.replies.streamReply({ params: { vault_id: vaultId, reply_id: replyId } })),
    ReplySnapshot,
    (snapshot) => !isReplyPending(snapshot.status),
  );

export const allVaults = (api: Api) =>
  Effect.gen(function* () {
    const first = yield* api.vaults.listVaults({ query: { limit: VAULT_PAGE, offset: 0 } });
    const items: Vault[] = [...first.items];
    const roles = { ...first.roles };
    for (let offset = items.length; offset < first.pagination.total;) {
      const page = yield* api.vaults.listVaults({ query: { limit: VAULT_PAGE, offset } });
      if (page.items.length === 0) break;
      items.push(...page.items);
      Object.assign(roles, page.roles);
      offset += page.items.length;
    }
    return { items, roles };
  });
