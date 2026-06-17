import { z } from "zod";
import type { AuthCodeDeliveryConfig, StorageConfig } from "./context.js";
import type { OpenRouterConfig } from "./openrouter.js";

const BooleanEnvSchema = z
  .enum(["true", "false", "1", "0"])
  .default("false")
  .transform((value) => value === "true" || value === "1");

const EnvSchema = z
  .object({
    DATABASE_URL: z.string().trim().min(1),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    JWT_SECRET: z.string().trim().min(32),
    JWT_ACCESS_EXPIRY_MINUTES: z.coerce.number().int().positive().default(15),
    JWT_REFRESH_EXPIRY_DAYS: z.coerce.number().int().positive().default(30),
    AUTH_CODE_EXPIRY_MINUTES: z.coerce.number().int().positive().default(10),
    SUPPRESS_AUTH: BooleanEnvSchema,
    DATA_DIR: z.string().trim().min(1).default("/data"),
    STORAGE_BACKEND: z.enum(["local", "r2"]).default("local"),
    R2_ACCOUNT_ID: z.string().trim().min(1).optional(),
    R2_ACCESS_KEY_ID: z.string().trim().min(1).optional(),
    R2_SECRET_ACCESS_KEY: z.string().trim().min(1).optional(),
    R2_BUCKET_PREFIX: z.string().trim().min(1).default("gm"),
    RESEND_API_KEY: z.string().trim().min(1).optional(),
    RESEND_FROM_EMAIL: z.string().trim().min(1).optional(),
    OPENROUTER_API_KEY: z.string().trim().min(1).optional(),
    OPENROUTER_BASE_URL: z.string().trim().url().default("https://openrouter.ai/api/v1"),
    OPENROUTER_APP_NAME: z.string().trim().min(1).optional(),
    OPENROUTER_SITE_URL: z.string().trim().url().optional(),
  })
  .refine(
    (env) => Boolean(env.RESEND_API_KEY) === Boolean(env.RESEND_FROM_EMAIL),
    "RESEND_API_KEY and RESEND_FROM_EMAIL must be configured together",
  )
  .refine(
    (env) =>
      env.STORAGE_BACKEND !== "r2" ||
      Boolean(env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY),
    "STORAGE_BACKEND=r2 requires R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY",
  );

export const env = EnvSchema.parse(process.env);

export function authCodeDeliveryFromEnv(): AuthCodeDeliveryConfig {
  if (env.RESEND_API_KEY && env.RESEND_FROM_EMAIL) {
    return { kind: "resend", apiKey: env.RESEND_API_KEY, fromEmail: env.RESEND_FROM_EMAIL };
  }

  return { kind: "console" };
}

export function storageFromEnv(): StorageConfig {
  if (env.STORAGE_BACKEND === "r2") {
    return {
      kind: "r2",
      accountId: env.R2_ACCOUNT_ID!,
      accessKeyId: env.R2_ACCESS_KEY_ID!,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
      bucketPrefix: env.R2_BUCKET_PREFIX,
    };
  }

  return { kind: "local", dataDir: env.DATA_DIR };
}

export function openAiProviderFromEnv(): OpenRouterConfig {
  if (!env.OPENROUTER_API_KEY) return { kind: "disabled" };

  return {
    kind: "openrouter",
    apiKey: env.OPENROUTER_API_KEY,
    baseUrl: env.OPENROUTER_BASE_URL,
    ...(env.OPENROUTER_APP_NAME ? { appName: env.OPENROUTER_APP_NAME } : {}),
    ...(env.OPENROUTER_SITE_URL ? { siteUrl: env.OPENROUTER_SITE_URL } : {}),
  };
}
