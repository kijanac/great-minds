import { Context, Effect, Layer } from "effect";

export interface OutputShape {
  readonly write: (text: string) => Effect.Effect<void>;
  readonly line: (text: string) => Effect.Effect<void>;
  readonly note: (text: string) => Effect.Effect<void>;
}

export class Output extends Context.Service<Output, OutputShape>()("@great-minds/cli/Output") {}

export const OutputLive = Layer.succeed(Output, {
  write: (text) => Effect.sync(() => void process.stdout.write(text)),
  line: (text) => Effect.sync(() => void process.stdout.write(`${text}\n`)),
  note: (text) => Effect.sync(() => void process.stderr.write(`${text}\n`)),
});
