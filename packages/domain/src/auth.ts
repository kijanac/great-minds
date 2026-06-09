import { createInsertSchema, createSelectSchema } from "drizzle-orm/zod";
import { z } from "zod";
import { apiKeys, apiKeyScope } from "@great-minds/db/schema";
import { UserIdSchema } from "./user.js";

export const ApiKeyIdSchema = z.string().uuid().brand<"ApiKeyId">();
export const AuthCodeSchema = z.string().trim().regex(/^\d{6}$/);
export const RefreshTokenSecretSchema = z.string().trim().min(1);
export const ApiKeyScopeSchema = createSelectSchema(apiKeyScope);
export const ApiKeyScopesSchema = z.array(ApiKeyScopeSchema).min(1).default(["query"]);

export const ApiKeySchema = createSelectSchema(apiKeys, {
  id: ApiKeyIdSchema,
  userId: UserIdSchema,
  scopes: z.array(ApiKeyScopeSchema),
}).pick({
  id: true,
  label: true,
  scopes: true,
  createdAt: true,
  revoked: true,
});

export const ApiKeyCreateSchema = createInsertSchema(apiKeys, {
  label: (schema) => schema.trim().min(1),
  scopes: ApiKeyScopesSchema,
}).pick({
  label: true,
  scopes: true,
});

export const ApiKeyWithSecretSchema = ApiKeySchema.extend({
  rawKey: z.string(),
});

export type ApiKeyId = z.infer<typeof ApiKeyIdSchema>;
export type ApiKeyScope = z.infer<typeof ApiKeyScopeSchema>;
export type ApiKeyCreate = z.infer<typeof ApiKeyCreateSchema>;
export type ApiKey = z.infer<typeof ApiKeySchema>;
export type ApiKeyWithSecret = z.infer<typeof ApiKeyWithSecretSchema>;
