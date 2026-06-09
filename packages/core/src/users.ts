import { eq } from "drizzle-orm";
import type { BackendDb } from "@great-minds/db/context";
import { users } from "@great-minds/db/schema";
import { UserSchema, type User, type UserCreate } from "@great-minds/domain/user";

export async function ensureUser(db: BackendDb, input: UserCreate): Promise<User> {
  const [created] = await db
    .insert(users)
    .values({ email: input.email })
    .onConflictDoNothing({ target: users.email })
    .returning();

  if (created) return UserSchema.parse(created);

  const [existing] = await db.select().from(users).where(eq(users.email, input.email)).limit(1);
  if (!existing) throw new Error("Failed to ensure user");

  return UserSchema.parse(existing);
}
