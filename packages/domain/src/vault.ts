import { createInsertSchema, createSelectSchema } from "drizzle-orm/zod";
import { z } from "zod";
import { memberRole, vaultMemberships, vaults } from "@great-minds/db/schema";
import { UserIdSchema, UserPublicSchema } from "./user.js";

export const VaultIdSchema = z.string().uuid().brand<"VaultId">();

export const VaultSchema = createSelectSchema(vaults, {
  id: VaultIdSchema,
  ownerId: UserIdSchema,
});

export const VaultCreateSchema = createInsertSchema(vaults, {
  name: (schema) => schema.trim().min(1),
  thematicHint: (schema) => schema.trim(),
  kinds: z.array(z.string().trim().min(1)).optional(),
}).pick({
  name: true,
  thematicHint: true,
  kinds: true,
});

export const VaultPatchSchema = VaultCreateSchema.partial();

export const VaultMemberRoleSchema = createSelectSchema(memberRole);

export const VaultMemberSchema = createSelectSchema(vaultMemberships, {
  userId: UserIdSchema,
  role: VaultMemberRoleSchema,
}).pick({ userId: true, role: true });

export const VaultMemberDetailsSchema = z.object({
  user: UserPublicSchema,
  role: VaultMemberRoleSchema,
});

export const VaultStatsSchema = z.object({
  articleCount: z.number().int().nonnegative(),
});

export type VaultId = z.infer<typeof VaultIdSchema>;
export type Vault = z.infer<typeof VaultSchema>;
export type VaultCreate = z.infer<typeof VaultCreateSchema>;
export type VaultPatch = z.infer<typeof VaultPatchSchema>;
export type VaultMemberRole = z.infer<typeof VaultMemberRoleSchema>;
export type VaultMemberDetails = z.infer<typeof VaultMemberDetailsSchema>;
export type VaultStats = z.infer<typeof VaultStatsSchema>;
