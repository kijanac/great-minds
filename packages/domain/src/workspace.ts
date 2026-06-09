import { z } from "zod";
import { UserPublicSchema } from "./user.js";
import { VaultSchema } from "./vault.js";

export const WorkspaceSchema = z.object({
  user: UserPublicSchema,
  vault: VaultSchema,
});

export type Workspace = z.infer<typeof WorkspaceSchema>;
