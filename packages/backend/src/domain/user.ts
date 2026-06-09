import { createSelectSchema } from "drizzle-orm/zod";
import { z } from "zod";
import { users } from "../db/schema.js";
import { UserIdSchema } from "./ids.js";

export const UserSchema = createSelectSchema(users).extend({
  id: UserIdSchema,
});

export const UserPublicSchema = UserSchema.pick({
  id: true,
  email: true,
});

export const UserCreateSchema = z.object({
  email: z.email(),
});

export type User = z.infer<typeof UserSchema>;
export type UserCreate = z.infer<typeof UserCreateSchema>;
export type UserPublic = z.infer<typeof UserPublicSchema>;
