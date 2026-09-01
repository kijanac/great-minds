import type { Uuid } from "@great-minds/domain";
import { Effect, Schema } from "effect";
import { parse as parseYaml } from "yaml";

import { type ContentStorage, vaultOwner } from "./storage.ts";

export type EnrichedField = {
  readonly name: string;
  readonly type: "string" | "list";
  readonly description: string;
};

export type VaultConfigFile = {
  readonly thematicHint: string;
  readonly kinds: readonly string[];
  readonly webSearch: boolean;
  readonly enrichedFields: readonly EnrichedField[];
};

export const defaultVaultConfigFile: VaultConfigFile = {
  thematicHint: "",
  kinds: ["person", "event", "organization", "concept"],
  webSearch: false,
  enrichedFields: [],
};

const decodeOr =
  <A>(decode: (value: unknown) => A, fallback: A) =>
  (value: unknown): A => {
    try {
      return decode(value);
    } catch {
      return fallback;
    }
  };

const decodeDocument = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));
const decodeRecordField = decodeOr(
  Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown)),
  undefined,
);
const decodeStringField = Schema.decodeUnknownSync(Schema.String);
const decodeStringsField = Schema.decodeUnknownSync(Schema.Array(Schema.String));
const decodeBooleanField = Schema.decodeUnknownSync(Schema.Boolean);

export const parseVaultConfigFile = (content: string): VaultConfigFile => {
  let document: Record<string, unknown>;
  try {
    document = decodeDocument(parseYaml(content));
  } catch {
    return defaultVaultConfigFile;
  }
  const kinds = decodeOr(decodeStringsField, defaultVaultConfigFile.kinds)(document.kinds).filter(
    (kind) => kind.length > 0,
  );
  const metadata = decodeRecordField(document.metadata) ?? {};
  const enrichedFields: EnrichedField[] = [];
  for (const [name, raw] of Object.entries(metadata)) {
    const spec = decodeRecordField(raw);
    if (spec === undefined) continue;
    enrichedFields.push({
      name,
      type: spec.type === "list" ? "list" : "string",
      description: decodeOr(decodeStringField, "")(spec.description),
    });
  }
  return {
    thematicHint: decodeOr(decodeStringField, "")(document.thematic_hint),
    kinds: kinds.length > 0 ? kinds : defaultVaultConfigFile.kinds,
    webSearch: decodeOr(decodeBooleanField, false)(document.web_search),
    enrichedFields,
  };
};

export const readVaultConfig = (storage: ContentStorage["Service"], vaultId: Uuid) =>
  storage.readText(vaultOwner(vaultId), "config.yaml").pipe(
    Effect.map(parseVaultConfigFile),
    Effect.catchTag("StorageFileMissing", () => Effect.succeed(defaultVaultConfigFile)),
  );
