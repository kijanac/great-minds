import { Cause } from "effect";

export type ErrorDetails = {
  readonly errorType: string;
  readonly message: string;
};

const nonEmptyString = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const recordField = (value: object, key: string): unknown =>
  key in value ? (value as Record<string, unknown>)[key] : undefined;

const errorType = (error: unknown) => {
  if (typeof error !== "object" || error === null) return typeof error;
  return (
    nonEmptyString(recordField(error, "errorType")) ??
    (error instanceof Error ? nonEmptyString(error.name) : undefined) ??
    nonEmptyString(recordField(error, "_tag")) ??
    nonEmptyString(recordField(error, "name")) ??
    "Object"
  );
};

const describe = (error: unknown, seen: Set<object>): ErrorDetails => {
  const type = errorType(error);
  if (typeof error !== "object" || error === null) {
    if (error === undefined) return { errorType: type, message: "Thrown value was undefined" };
    if (error === null) return { errorType: type, message: "Thrown value was null" };
    const message = String(error).trim();
    return {
      errorType: type,
      message: message.length > 0 ? message : `Thrown ${type} was empty`,
    };
  }
  if (seen.has(error)) return { errorType: type, message: `${type} contained a circular cause` };
  seen.add(error);

  const message =
    nonEmptyString(recordField(error, "message")) ??
    nonEmptyString(recordField(error, "detail")) ??
    nonEmptyString(recordField(error, "reason"));
  const nested = recordField(error, "cause");
  const nestedDetails =
    nested === undefined || nested === error ? undefined : describe(nested, seen);
  if (message !== undefined) {
    return {
      errorType: type,
      message:
        nestedDetails === undefined || message.includes(nestedDetails.message)
          ? message
          : `${message}: ${nestedDetails.message}`,
    };
  }
  if (nestedDetails !== undefined) return { errorType: type, message: nestedDetails.message };
  if (type === "TimeoutError") return { errorType: type, message: "Operation timed out" };
  return { errorType: type, message: `${type} occurred without an error message` };
};

export const errorDetails = (error: unknown): ErrorDetails => describe(error, new Set());

export const causeDetails = (cause: Cause.Cause<unknown>): ErrorDetails => {
  const fail = cause.reasons.find(Cause.isFailReason);
  if (fail !== undefined) return errorDetails(fail.error);
  const die = cause.reasons.find(Cause.isDieReason);
  if (die !== undefined) return errorDetails(die.defect);
  if (cause.reasons.some(Cause.isInterruptReason)) {
    return { errorType: "Interrupted", message: "Workflow execution was interrupted" };
  }
  return errorDetails(Cause.pretty(cause));
};

export const formatError = (details: ErrorDetails) => `${details.errorType}: ${details.message}`;
