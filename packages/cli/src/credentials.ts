import { homedir } from "node:os";

import { Uuid } from "@great-minds/domain";
import { Config, Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";

import { CredentialsUnreadable, InsecureApiUrl, NotSignedIn } from "./errors.ts";

export const DEFAULT_API_URL = "https://great-minds-api.onrender.com/v1";

export const SavedCredentials = Schema.Struct({
  api_url: Schema.String,
  api_key: Schema.String,
  api_key_id: Schema.NullOr(Uuid),
  vault_id: Schema.NullOr(Uuid),
});
export type SavedCredentials = typeof SavedCredentials.Type;

export type SignedIn = {
  readonly apiUrl: string;
  readonly apiKey: string;
  readonly vault: Option.Option<string>;
};

export interface CredentialsShape {
  readonly path: string;
  readonly keyFromEnvironment: boolean;
  readonly vaultFromEnvironment: boolean;
  readonly load: Effect.Effect<Option.Option<SavedCredentials>, CredentialsUnreadable>;
  readonly save: (credentials: SavedCredentials) => Effect.Effect<void>;
  readonly clear: Effect.Effect<void>;
  readonly apiUrl: (
    flag: Option.Option<string>,
    saved: Option.Option<SavedCredentials>,
  ) => Effect.Effect<string, InsecureApiUrl>;
  readonly signedIn: Effect.Effect<SignedIn, NotSignedIn | CredentialsUnreadable | InsecureApiUrl>;
}

export class Credentials extends Context.Service<Credentials, CredentialsShape>()(
  "@great-minds/cli/Credentials",
) {}

const decodeSaved = Schema.decodeUnknownEffect(Schema.fromJsonString(SavedCredentials));
const encodeSaved = Schema.encodeSync(Schema.fromJsonString(SavedCredentials));
const setting = (name: string) => Config.option(Config.NonEmptyString(name));
const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
const isAllowedUrl = (url: string) => {
  if (!URL.canParse(url)) return false;
  const parsed = new URL(url);
  return (
    parsed.protocol === "https:" || (parsed.protocol === "http:" && localHosts.has(parsed.hostname))
  );
};

const makeCredentials = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configDir = yield* setting("GM_CONFIG_DIR");
  const envKey = yield* setting("GM_API_KEY");
  const envUrl = yield* setting("GM_API_URL");
  const envVault = yield* setting("GM_VAULT");
  const directory = path.resolve(
    Option.getOrElse(configDir, () => path.join(homedir(), ".config", "great-minds")),
  );
  const file = path.join(directory, "credentials.json");

  const load = Effect.gen(function* () {
    const exists = yield* fs.exists(file).pipe(Effect.orDie);
    if (!exists) return Option.none();
    const text = yield* fs.readFileString(file).pipe(Effect.orDie);
    return Option.some(
      yield* decodeSaved(text).pipe(
        Effect.mapError(() => new CredentialsUnreadable({ path: file })),
      ),
    );
  });

  const save = (credentials: SavedCredentials) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
      yield* fs.chmod(directory, 0o700);
      const temporary = path.join(directory, `credentials.${crypto.randomUUID()}.tmp`);
      yield* fs.writeFileString(temporary, `${encodeSaved(credentials)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      yield* fs.rename(temporary, file);
    }).pipe(Effect.orDie);

  const clear = fs.remove(file, { force: true }).pipe(Effect.orDie);

  const apiUrl = (flag: Option.Option<string>, saved: Option.Option<SavedCredentials>) => {
    const url = Option.getOrElse(
      Option.orElse(
        Option.orElse(flag, () => envUrl),
        () => Option.map(saved, (found) => found.api_url),
      ),
      () => DEFAULT_API_URL,
    );
    return isAllowedUrl(url) ? Effect.succeed(url) : Effect.fail(new InsecureApiUrl({ url }));
  };

  const signedIn = Effect.gen(function* () {
    const saved = yield* load;
    const url = yield* apiUrl(Option.none(), saved);
    const sameServer = Option.filter(saved, (found) => found.api_url === url);
    const apiKey = Option.orElse(envKey, () => Option.map(sameServer, (found) => found.api_key));
    if (Option.isNone(apiKey)) return yield* new NotSignedIn();
    const savedVault = Option.isSome(envKey)
      ? Option.none()
      : Option.flatMap(sameServer, (found) => Option.fromNullishOr(found.vault_id));
    return {
      apiUrl: url,
      apiKey: apiKey.value,
      vault: Option.orElse(envVault, () => savedVault),
    } satisfies SignedIn;
  });

  return {
    path: file,
    keyFromEnvironment: Option.isSome(envKey),
    vaultFromEnvironment: Option.isSome(envVault),
    load,
    save,
    clear,
    apiUrl,
    signedIn,
  } satisfies CredentialsShape;
});

export const CredentialsLive = Layer.effect(Credentials, makeCredentials);
