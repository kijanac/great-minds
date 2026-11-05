import { DomainErrorSchema } from "@great-minds/domain";
import { Schema } from "effect";

const isDomainError = Schema.is(DomainErrorSchema);

export function domainErrorDetail(error: unknown): string | undefined {
  return isDomainError(error) ? error.detail : undefined;
}

export function errorMessage(error: unknown, fallback = "Something went wrong."): string {
  const detail = domainErrorDetail(error);
  if (detail !== undefined) return detail;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
