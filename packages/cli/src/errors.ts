import { Data } from "effect";

const detail = (error: string | null) => (error === null ? "" : `: ${error}`);

export class NotSignedIn extends Data.TaggedError("NotSignedIn")<{}> {
  override get message() {
    return "not signed in: run gm login, or set GM_API_KEY";
  }
}

export class CredentialsUnreadable extends Data.TaggedError("CredentialsUnreadable")<{
  readonly path: string;
}> {
  override get message() {
    return `cannot read ${this.path}: run gm login to replace it, or gm logout to remove it`;
  }
}

export class InsecureApiUrl extends Data.TaggedError("InsecureApiUrl")<{
  readonly url: string;
}> {
  override get message() {
    return `refusing ${this.url}: the API URL must use https (http only for localhost)`;
  }
}

export class VaultChoiceNeeded extends Data.TaggedError("VaultChoiceNeeded")<{
  readonly count: number;
}> {
  override get message() {
    return this.count === 0
      ? "you have no vaults yet"
      : `you have ${this.count} vaults: choose one with gm vault use <name>, or pass --vault`;
  }
}

export class VaultNotFound extends Data.TaggedError("VaultNotFound")<{
  readonly vault: string;
}> {
  override get message() {
    return `no vault named "${this.vault}" (gm vaults lists yours)`;
  }
}

export class VaultNameAmbiguous extends Data.TaggedError("VaultNameAmbiguous")<{
  readonly vault: string;
  readonly count: number;
}> {
  override get message() {
    return `${this.count} vaults are named "${this.vault}"; use its id`;
  }
}

export class VaultNotAccessible extends Data.TaggedError("VaultNotAccessible")<{
  readonly vault: string;
}> {
  override get message() {
    return `vault ${this.vault} was not found or you cannot access it (gm vaults lists yours)`;
  }
}

export class VaultUseNeedsLogin extends Data.TaggedError("VaultUseNeedsLogin")<{}> {
  override get message() {
    return "gm vault use saves to the credentials from gm login; with GM_API_KEY, set GM_VAULT instead";
  }
}

export class KeyNotRevoked extends Data.TaggedError("KeyNotRevoked")<{
  readonly keyId: string;
  readonly reason: string;
}> {
  override get message() {
    return `could not revoke the saved key (${this.reason}); it is still saved, so run gm logout again or revoke it in Settings: ${this.keyId}`;
  }
}

export class StreamEnded extends Data.TaggedError("StreamEnded")<{
  readonly what: "answer" | "run";
}> {
  override get message() {
    return this.what === "answer"
      ? "the answer stream ended before the answer finished"
      : "the progress stream ended before the run finished";
  }
}

export class ReplyNotCompleted extends Data.TaggedError("ReplyNotCompleted")<{
  readonly status: string;
  readonly error: string | null;
}> {
  override get message() {
    return `the answer ${this.status}${detail(this.error)}`;
  }
}

export class RunStopped extends Data.TaggedError("RunStopped")<{
  readonly headline: string;
  readonly error: string | null;
}> {
  override get message() {
    return `${this.headline}${detail(this.error)}`;
  }
}
