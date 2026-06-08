import { createSelectSchema } from "drizzle-orm/zod";
import { appState } from "../db/schema";

export type AppState = typeof appState.$inferSelect;
export const AppStateSchema = createSelectSchema(appState);
