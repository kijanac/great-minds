import { Effect } from "effect";
import { eq } from "drizzle-orm";
import { Db } from "@great-minds/db/context";
import { users } from "@great-minds/db/schema";
import { UserSchema, type User, type UserCreate } from "@great-minds/domain/user";
import { firstOrDie } from "./effect-helpers.js";

export function ensureUser(input: UserCreate): Effect.Effect<User, never, Db> {
  return Effect.gen(function* () {
    const db = yield* Db;
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

function parseUser(value: unknown): User {
  return UserSchema.parse(value);
}
