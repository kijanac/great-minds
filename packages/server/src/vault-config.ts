import type { Uuid } from "@great-minds/domain";
import { Effect, Option, Schema } from "effect";
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

const decodeRecordField = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown));
const decodeStringField = Schema.decodeUnknownOption(Schema.String);
const decodeStringsField = Schema.decodeUnknownOption(Schema.Array(Schema.String));
const decodeBooleanField = Schema.decodeUnknownOption(Schema.Boolean);

export const parseVaultConfigFile = (content: string): VaultConfigFile => {
  let yaml: unknown;
  try {
    yaml = parseYaml(content);
  } catch {
    return defaultVaultConfigFile;
  }
  const document = Option.getOrUndefined(decodeRecordField(yaml));
  if (document === undefined) return defaultVaultConfigFile;
  const kinds = Option.getOrElse(
    decodeStringsField(document.kinds),
    () => defaultVaultConfigFile.kinds,
  ).filter((kind) => kind.length > 0);
  const metadata = Option.getOrElse(decodeRecordField(document.metadata), () => ({}));
  const enrichedFields: EnrichedField[] = [];
  for (const [name, raw] of Object.entries(metadata)) {
    const spec = Option.getOrUndefined(decodeRecordField(raw));
    if (spec === undefined) continue;
    enrichedFields.push({
      name,
      type: spec.type === "list" ? "list" : "string",
      description: Option.getOrElse(decodeStringField(spec.description), () => ""),
    });
  }
  return {
    thematicHint: Option.getOrElse(decodeStringField(document.thematic_hint), () => ""),
    kinds: kinds.length > 0 ? kinds : defaultVaultConfigFile.kinds,
    webSearch: Option.getOrElse(decodeBooleanField(document.web_search), () => false),
    enrichedFields,
  };
};

export const readVaultConfig = (storage: ContentStorage["Service"], vaultId: Uuid) =>
  storage.readText(vaultOwner(vaultId), "config.yaml").pipe(
    Effect.map(parseVaultConfigFile),
    Effect.catchTag("StorageFileMissing", () => Effect.succeed(defaultVaultConfigFile)),
  );
