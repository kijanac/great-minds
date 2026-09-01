import { type SharedShareDetail } from "@great-minds/domain";
import { Effect } from "effect";

import { api, run } from "./app";

export type {
  ShareCreateResult,
  ShareOverview,
  ShareSubjectKind,
  SharedAnnotation,
  SharedReferenceDetail,
  SharedSessionDetail,
  SharedShareDetail,
} from "@great-minds/domain";

export type ResolveShareResult = { status: "ok"; share: SharedShareDetail } | { status: "gone" };

export function resolveShare(token: string): Promise<ResolveShareResult> {
  return run(
    api.public.resolveShare({ params: { token } }).pipe(
      Effect.map((share) => ({ status: "ok", share }) as const),
      Effect.catchTag("NotFound", () => Effect.succeed({ status: "gone" } as const)),
    ),
  );
}
