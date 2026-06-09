import { z } from "zod";
import type { AuthCodeDeliveryConfig } from "./context.js";

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
    RESEND_API_KEY: z.string().trim().min(1).optional(),
    RESEND_FROM_EMAIL: z.string().trim().min(1).optional(),
  })
  .refine(
    (env) => Boolean(env.RESEND_API_KEY) === Boolean(env.RESEND_FROM_EMAIL),
    "RESEND_API_KEY and RESEND_FROM_EMAIL must be configured together",
  );

export const env = EnvSchema.parse(process.env);

export function authCodeDeliveryFromEnv(): AuthCodeDeliveryConfig {
  if (env.RESEND_API_KEY && env.RESEND_FROM_EMAIL) {
    return { kind: "resend", apiKey: env.RESEND_API_KEY, fromEmail: env.RESEND_FROM_EMAIL };
  }

  return { kind: "console" };
}
