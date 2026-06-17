import { Data, Effect } from "effect";
import { eq } from "drizzle-orm";
import { Db, type DbSession } from "@great-minds/db/context";
import { users } from "@great-minds/db/schema";
import { UserSchema, type User, type UserCreate, type UserId } from "@great-minds/domain/user";
import { firstOrDie, firstOrFail } from "./effect-helpers.js";

export class UserUnavailable extends Data.TaggedError("UserUnavailable")<{
  message: string;
}> {}

export function ensureUser(input: UserCreate): Effect.Effect<User, never, Db> {
  return Effect.gen(function* () {
    const db = yield* Db;
    return yield* ensureUserWith(db, input);
  });
}

export function ensureUserWith(db: DbSession, input: UserCreate): Effect.Effect<User> {
  return Effect.gen(function* () {
    const [created] = yield* db
      .insert(users)
      .values({ email: input.email })
      .onConflictDoNothing({ target: users.email })
      .returning()
      .pipe(Effect.orDie);

    if (created) return parseUser(created);

    const rows = yield* db
      .select()
      .from(users)
      .where(eq(users.email, input.email))
      .limit(1)
      .pipe(Effect.orDie);

    const existing = yield* firstOrDie(rows, "Failed to ensure user");
    return parseUser(existing);
  });
}

export function getUserByIdWith(
  db: DbSession,
  userId: UserId,
): Effect.Effect<User, UserUnavailable> {
  return Effect.gen(function* () {
    const rows = yield* db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .pipe(Effect.orDie);

    const user = yield* firstOrFail(rows, () => new UserUnavailable({ message: "User not found" }));
    return parseUser(user);
  });
}

function parseUser(value: unknown): User {
  return UserSchema.parse(value);
}
