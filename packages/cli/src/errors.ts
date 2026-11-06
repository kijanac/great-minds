import { errorMessage } from "@great-minds/client";
import { Data } from "effect";

export class NotSignedIn extends Data.TaggedError("NotSignedIn")<{}> {}

export class CredentialsUnreadable extends Data.TaggedError("CredentialsUnreadable")<{
  readonly path: string;
}> {}

export class NoVaults extends Data.TaggedError("NoVaults")<{}> {}

export class VaultChoiceNeeded extends Data.TaggedError("VaultChoiceNeeded")<{
  readonly count: number;
}> {}

export class VaultNotFound extends Data.TaggedError("VaultNotFound")<{
  readonly vault: string;
}> {}

export class VaultNameAmbiguous extends Data.TaggedError("VaultNameAmbiguous")<{
  readonly vault: string;
  readonly count: number;
}> {}

export class VaultUseNeedsLogin extends Data.TaggedError("VaultUseNeedsLogin")<{}> {}

export class LimitOutOfRange extends Data.TaggedError("LimitOutOfRange")<{
  readonly limit: number;
}> {}

export class StreamEnded extends Data.TaggedError("StreamEnded")<{
  readonly what: "answer" | "run";
}> {}

export class ReplyNotCompleted extends Data.TaggedError("ReplyNotCompleted")<{
  readonly status: string;
  readonly error: string | null;
}> {}

export class RunStopped extends Data.TaggedError("RunStopped")<{
  readonly headline: string;
  readonly error: string | null;
}> {}

export type CliFailure =
  | NotSignedIn
  | CredentialsUnreadable
  | NoVaults
  | VaultChoiceNeeded
  | VaultNotFound
  | VaultNameAmbiguous
  | VaultUseNeedsLogin
  | LimitOutOfRange
  | StreamEnded
  | ReplyNotCompleted
  | RunStopped;

const describeCli = (failure: CliFailure) => {
  switch (failure._tag) {
    case "NotSignedIn":
      return "not signed in: run gm login, or set GM_API_KEY";
    case "CredentialsUnreadable":
      return `cannot read ${failure.path}: run gm login to replace it, or gm logout to remove it`;
    case "NoVaults":
      return "you have no vaults yet";
    case "VaultChoiceNeeded":
      return `you have ${failure.count} vaults: choose one with gm vault use <name>, or pass --vault`;
    case "VaultNotFound":
      return `no vault named "${failure.vault}" (gm vaults lists yours)`;
    case "VaultNameAmbiguous":
      return `${failure.count} vaults are named "${failure.vault}"; use its id`;
    case "VaultUseNeedsLogin":
      return "gm vault use saves to the credentials from gm login; with GM_API_KEY, set GM_VAULT instead";
    case "LimitOutOfRange":
      return `--limit must be between 1 and 200 (got ${failure.limit})`;
    case "StreamEnded":
      return failure.what === "answer"
        ? "the answer stream ended before the answer finished"
        : "the progress stream ended before the run finished";
    case "ReplyNotCompleted":
      return `the answer ${failure.status}${failure.error === null ? "" : `: ${failure.error}`}`;
    case "RunStopped":
      return `${failure.headline}${failure.error === null ? "" : `: ${failure.error}`}`;
  }
};

const cliTags = new Set<string>([
  "NotSignedIn",
  "CredentialsUnreadable",
  "NoVaults",
  "VaultChoiceNeeded",
  "VaultNotFound",
  "VaultNameAmbiguous",
  "VaultUseNeedsLogin",
  "LimitOutOfRange",
  "StreamEnded",
  "ReplyNotCompleted",
  "RunStopped",
]);

const isCliFailure = (error: unknown): error is CliFailure =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  typeof error._tag === "string" &&
  cliTags.has(error._tag);

export const describeFailure = (error: unknown) =>
  isCliFailure(error) ? describeCli(error) : errorMessage(error);
