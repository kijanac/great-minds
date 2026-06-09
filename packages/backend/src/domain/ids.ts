import { z } from "zod";

export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type UserId = Brand<string, "UserId">;
export type VaultId = Brand<string, "VaultId">;
export type SourceDocumentId = Brand<string, "SourceDocumentId">;
export type ApiKeyId = Brand<string, "ApiKeyId">;
export type RequestId = Brand<string, "RequestId">;

const uuid = z.string().uuid();

export const UserIdSchema = uuid.transform((value) => value as UserId);
export const VaultIdSchema = uuid.transform((value) => value as VaultId);
export const SourceDocumentIdSchema = uuid.transform((value) => value as SourceDocumentId);
export const ApiKeyIdSchema = uuid.transform((value) => value as ApiKeyId);
export const RequestIdSchema = uuid.transform((value) => value as RequestId);
