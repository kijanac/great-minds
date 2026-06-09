import { createSelectSchema } from "drizzle-orm/zod";
import { z } from "zod";
import { vaultMemberships, vaults } from "../db/schema.js";
import { UserIdSchema, VaultIdSchema } from "./ids.js";

export const VaultSchema = createSelectSchema(vaults).extend({
  id: VaultIdSchema,
  ownerId: UserIdSchema,
});

export const VaultCreateSchema = z.object({
  name: z.string().trim().min(1),
  thematicHint: z.string().trim().optional(),
  kinds: z.array(z.string().trim().min(1)).optional(),
});

export const VaultPatchSchema = VaultCreateSchema.partial().extend({
  vaultId: VaultIdSchema,
});

export const VaultMemberSchema = createSelectSchema(vaultMemberships)
  .pick({ userId: true, role: true })
  .extend({ userId: UserIdSchema });

export const VaultSettingsSchema = z.object({
  vault: VaultSchema,
  members: z.array(
    z.object({
      userId: UserIdSchema,
      email: z.email(),
      role: VaultMemberSchema.shape.role,
    }),
  ),
  articleCount: z.number().int().nonnegative(),
});

export type Vault = z.infer<typeof VaultSchema>;
export type VaultCreate = z.infer<typeof VaultCreateSchema>;
export type VaultPatch = z.infer<typeof VaultPatchSchema>;
export type VaultSettings = z.infer<typeof VaultSettingsSchema>;
