import { createInsertSchema, createSelectSchema } from "drizzle-orm/zod";
import { z } from "zod";
import { memberRole, vaultMemberships, vaults } from "@great-minds/db/schema";
import { UserCreateSchema, UserIdSchema, UserPublicSchema } from "./user.js";

export const VaultIdSchema = z.string().uuid().brand<"VaultId">();

export const VaultInternalSchema = createSelectSchema(vaults, {
  id: VaultIdSchema,
  ownerId: UserIdSchema,
});

export const VaultSchema = VaultInternalSchema.omit({ storageBucketName: true });

export const VaultCreateSchema = createInsertSchema(vaults, {
  name: (schema) => schema.trim().min(1),
  thematicHint: (schema) => schema.trim(),
  kinds: z.array(z.string().trim().min(1)).optional(),
}).pick({
  name: true,
  storageBucketName: true,
  thematicHint: true,
  kinds: true,
});

export const VaultCreateCommandSchema = VaultCreateSchema.omit({ storageBucketName: true });
export const VaultPatchSchema = VaultCreateCommandSchema.partial();

export const VaultMemberRoleSchema = createSelectSchema(memberRole);

export const VaultMemberSchema = createSelectSchema(vaultMemberships, {
  userId: UserIdSchema,
  role: VaultMemberRoleSchema,
}).pick({ userId: true, role: true });

export const VaultMemberInviteSchema = UserCreateSchema.extend({
  role: VaultMemberRoleSchema,
});

export const VaultMemberUpdateSchema = z.object({
  role: VaultMemberRoleSchema,
});

export const VaultMemberDetailsSchema = z.object({
  user: UserPublicSchema,
  role: VaultMemberRoleSchema,
});

export const VaultStatsSchema = z.object({
  articleCount: z.number().int().nonnegative(),
});

export type VaultId = z.infer<typeof VaultIdSchema>;
export type VaultInternal = z.infer<typeof VaultInternalSchema>;
export type Vault = z.infer<typeof VaultSchema>;
export type VaultCreate = z.infer<typeof VaultCreateSchema>;
export type VaultCreateCommand = z.infer<typeof VaultCreateCommandSchema>;
export type VaultPatch = z.infer<typeof VaultPatchSchema>;
export type VaultMemberRole = z.infer<typeof VaultMemberRoleSchema>;
export type VaultMemberInvite = z.infer<typeof VaultMemberInviteSchema>;
export type VaultMemberUpdate = z.infer<typeof VaultMemberUpdateSchema>;
export type VaultMemberDetails = z.infer<typeof VaultMemberDetailsSchema>;
export type VaultStats = z.infer<typeof VaultStatsSchema>;
