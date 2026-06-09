import { createInsertSchema, createSelectSchema } from "drizzle-orm/zod";
import { z } from "zod";
import { users } from "@great-minds/db/schema";

export const UserIdSchema = z.string().uuid().brand<"UserId">();

export const UserSchema = createSelectSchema(users, {
  id: UserIdSchema,
});

export const UserPublicSchema = UserSchema.pick({
  id: true,
  email: true,
});

export const UserCreateSchema = createInsertSchema(users, {
  email: (schema) => schema.trim().toLowerCase().pipe(z.email()),
}).pick({
  email: true,
});

export type UserId = z.infer<typeof UserIdSchema>;
export type User = z.infer<typeof UserSchema>;
export type UserCreate = z.infer<typeof UserCreateSchema>;
export type UserPublic = z.infer<typeof UserPublicSchema>;
