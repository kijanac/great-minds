import { createSelectSchema } from "drizzle-orm/zod";
import { z } from "zod";
import { memberRole } from "../db/schema";

export const MemberRoleSchema = createSelectSchema(memberRole);
export type MemberRole = z.infer<typeof MemberRoleSchema>;
