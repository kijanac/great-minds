import { z } from "zod";
import { MemberRoleSchema } from "./member-role";
import { VaultSchema } from "./vault";

export const VaultMemberSchema = z.object({
  userId: z.string(),
  email: z.string(),
  role: MemberRoleSchema,
});

export type VaultMember = z.infer<typeof VaultMemberSchema>;

export const VaultSettingsSchema = z.object({
  vault: VaultSchema,
  members: z.array(VaultMemberSchema),
  articleCount: z.number().int().nonnegative(),
});

export type VaultSettings = z.infer<typeof VaultSettingsSchema>;
