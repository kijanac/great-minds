import { homedir } from "node:os";

import { Uuid } from "@great-minds/domain";
import { Config, Context, Data, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";

export const DEFAULT_API_URL = "https://great-minds-api.onrender.com/v1";

export const SavedCredentials = Schema.Struct({
  api_url: Schema.String,
  api_key: Schema.String,
  api_key_id: Schema.NullOr(Uuid),
  vault_id: Schema.NullOr(Uuid),
});
export type SavedCredentials = typeof SavedCredentials.Type;

export type Login = {
  readonly apiUrl: string;
  readonly apiKey: string;
  readonly vault: Option.Option<string>;
  readonly saved: Option.Option<SavedCredentials>;
};

export class NotSignedIn extends Data.TaggedError("NotSignedIn")<{
  readonly message: string;
}> {}

export class CredentialsUnreadable extends Data.TaggedError("CredentialsUnreadable")<{
  readonly message: string;
}> {}

export interface CredentialsShape {
  readonly path: string;
  readonly load: Effect.Effect<Option.Option<SavedCredentials>, CredentialsUnreadable>;
  readonly save: (credentials: SavedCredentials) => Effect.Effect<void>;
  readonly clear: Effect.Effect<void>;
  readonly login: Effect.Effect<Login, NotSignedIn | CredentialsUnreadable>;
}

export class Credentials extends Context.Service<Credentials, CredentialsShape>()(
  "@great-minds/cli/Credentials",
) {}

const decodeSaved = Schema.decodeUnknownEffect(Schema.fromJsonString(SavedCredentials));
const encodeSaved = Schema.encodeSync(Schema.fromJsonString(SavedCredentials));

const makeCredentials = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configDir = yield* Config.option(Config.string("GM_CONFIG_DIR"));
  const envKey = yield* Config.option(Config.string("GM_API_KEY"));
  const envUrl = yield* Config.option(Config.string("GM_API_URL"));
  const envVault = yield* Config.option(Config.string("GM_VAULT"));
  const directory = Option.getOrElse(configDir, () =>
    path.join(homedir(), ".config", "great-minds"),
  );
  const file = path.join(directory, "credentials.json");

  const load = Effect.gen(function* () {
    if (!(yield* fs.exists(file).pipe(Effect.orDie))) return Option.none();
    const text = yield* fs.readFileString(file).pipe(Effect.orDie);
    return Option.some(
      yield* decodeSaved(text).pipe(
        Effect.mapError(
          () => new CredentialsUnreadable({ message: `cannot read ${file}: run gm login again` }),
        ),
      ),
    );
  });

  const save = (credentials: SavedCredentials) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
      yield* fs.writeFileString(file, `${encodeSaved(credentials)}\n`, { mode: 0o600 });
      yield* fs.chmod(file, 0o600);
    }).pipe(Effect.orDie);

  const clear = fs.remove(file, { force: true }).pipe(Effect.orDie);

  const login = Effect.gen(function* () {
    const saved = yield* load;
    const apiKey = Option.orElse(envKey, () => Option.map(saved, (found) => found.api_key));
    if (Option.isNone(apiKey))
      return yield* new NotSignedIn({ message: "not signed in: run gm login, or set GM_API_KEY" });
    return {
      apiUrl: Option.getOrElse(
        Option.orElse(envUrl, () => Option.map(saved, (found) => found.api_url)),
        () => DEFAULT_API_URL,
      ),
      apiKey: apiKey.value,
      vault: Option.orElse(envVault, () =>
        Option.flatMap(saved, (found) => Option.fromNullishOr(found.vault_id)),
      ),
      saved,
    } satisfies Login;
  });

  return { path: file, load, save, clear, login } satisfies CredentialsShape;
});

export const CredentialsLive = Layer.effect(Credentials, makeCredentials);
