import type { Uuid } from "@great-minds/domain";
import { Data, Effect, Option, Schema } from "effect";
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

export class VaultConfigMalformed extends Data.TaggedError("VaultConfigMalformed")<{
  readonly vaultId: Uuid;
}> {}

export const VAULT_CONFIG_PATH = "config.yaml";

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

const vaultConfigFromDocument = (document: {
  readonly [key: string]: unknown;
}): VaultConfigFile => {
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

const parseVaultConfigFile = (vaultId: Uuid, content: string) =>
  Effect.gen(function* () {
    const yaml: unknown = yield* Effect.try({
      try: () => parseYaml(content),
      catch: () => new VaultConfigMalformed({ vaultId }),
    });
    if (yaml === null) return defaultVaultConfigFile;
    const document = decodeRecordField(yaml);
    if (Option.isNone(document)) return yield* new VaultConfigMalformed({ vaultId });
    return vaultConfigFromDocument(document.value);
  });

export const readVaultConfig = (storage: ContentStorage["Service"], vaultId: Uuid) =>
  storage.readText(vaultOwner(vaultId), VAULT_CONFIG_PATH).pipe(
    Effect.flatMap((content) => parseVaultConfigFile(vaultId, content)),
    Effect.catchTag("StorageFileMissing", () => Effect.succeed(defaultVaultConfigFile)),
  );
