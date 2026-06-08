import { createSelectSchema } from "drizzle-orm/zod";
import { z } from "zod";
import { vaults } from "../db/schema";

export type Vault = typeof vaults.$inferSelect;
export const VaultSchema = createSelectSchema(vaults);

export const CreateVaultCommandSchema = z.object({
  name: z.string().trim().min(1),
  thematicHint: z.string().trim().optional(),
  kinds: z.array(z.string()).optional(),
});

export type CreateVaultCommand = z.infer<typeof CreateVaultCommandSchema>;

export const UpdateVaultCommandSchema = z.object({
  vaultId: z.string(),
  name: z.string().trim().min(1).optional(),
  thematicHint: z.string().trim().optional(),
  kinds: z.array(z.string()).optional(),
});

export type UpdateVaultCommand = z.infer<typeof UpdateVaultCommandSchema>;
