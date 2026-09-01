import { DomainErrorSchema } from "@great-minds/domain";
import { Schema } from "effect";

const isDomainError = Schema.is(DomainErrorSchema);

export function errorMessage(error: unknown, fallback = "Something went wrong."): string {
  if (isDomainError(error)) return error.detail;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
