import { z } from "zod";
import { AppStateSchema } from "./app-state";
import { UserSchema } from "./user";
import { VaultSchema } from "./vault";

export const WorkspaceSchema = z.object({
  appState: AppStateSchema,
  user: UserSchema,
  vault: VaultSchema,
});

export type Workspace = z.infer<typeof WorkspaceSchema>;
