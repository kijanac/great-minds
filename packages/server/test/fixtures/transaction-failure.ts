import type { Database } from "@great-minds/database";
import { Effect } from "effect";

export const failTransactions = (
  db: Database["Service"],
  fault: Error,
  phase: "rollback" | "lost-ack",
): Database["Service"] => ({
  ...db,
  transaction: (run) =>
    phase === "lost-ack"
      ? Effect.gen(function* () {
          yield* db.transaction(run);
          return yield* Effect.die(fault);
        })
      : db.transaction((tx) =>
          Effect.gen(function* () {
            yield* run(tx);
            return yield* Effect.die(fault);
          }),
        ),
});
