import { Effect } from "effect";

export const scopedAbortSignal = Effect.acquireRelease(
  Effect.sync(() => new AbortController()),
  (controller) => Effect.sync(() => controller.abort()),
).pipe(Effect.map((controller) => controller.signal));
