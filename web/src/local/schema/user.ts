import { createSelectSchema } from "drizzle-orm/zod";
import { users } from "../db/schema";

export type User = typeof users.$inferSelect;
export const UserSchema = createSelectSchema(users);
