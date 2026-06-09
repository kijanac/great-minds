import { eq } from "drizzle-orm";
import type { BackendDb } from "../db/context.js";
import { users } from "../db/schema.js";
import { UserSchema, type User } from "../domain/user.js";

export async function ensureUser(db: BackendDb, email: string): Promise<User> {
  const normalizedEmail = email.trim().toLowerCase();

  const [created] = await db
    .insert(users)
    .values({ email: normalizedEmail })
    .onConflictDoNothing({ target: users.email })
    .returning();

  if (created) return UserSchema.parse(created);

  const [existing] = await db.select().from(users).where(eq(users.email, normalizedEmail)).limit(1);
  if (!existing) throw new Error("Failed to ensure user");

  return UserSchema.parse(existing);
}
