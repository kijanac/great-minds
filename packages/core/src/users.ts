import { Data, Effect } from "effect";
import { eq } from "drizzle-orm";
import type { BackendDb } from "@great-minds/db/context";
import { users } from "@great-minds/db/schema";
import { UserSchema, type User, type UserCreate } from "@great-minds/domain/user";
import { firstOrFail, parseOrFail } from "./effect-helpers.js";

export class UserPersistenceFailed extends Data.TaggedError("UserPersistenceFailed")<{
  message: string;
}> {}

export function ensureUser(db: BackendDb, input: UserCreate): Effect.Effect<User, UserPersistenceFailed> {
  return Effect.gen(function* () {
    const [created] = yield* db
      .insert(users)
      .values({ email: input.email })
      .onConflictDoNothing({ target: users.email })
      .returning()
      .pipe(Effect.mapError(() => new UserPersistenceFailed({ message: "Failed to ensure user" })));

    if (created) return yield* parseUser(created);

    const rows = yield* db
      .select()
      .from(users)
      .where(eq(users.email, input.email))
      .limit(1)
      .pipe(Effect.mapError(() => new UserPersistenceFailed({ message: "Failed to ensure user" })));

    const existing = yield* firstOrFail(rows, () => new UserPersistenceFailed({ message: "Failed to ensure user" }));
    return yield* parseUser(existing);
  });
}

function parseUser(value: unknown): Effect.Effect<User, UserPersistenceFailed> {
  return parseOrFail(() => UserSchema.parse(value), () => new UserPersistenceFailed({ message: "Failed to ensure user" }));
}
