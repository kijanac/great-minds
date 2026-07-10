import { Context, Effect, Layer } from "effect";

type LogFields = Record<string, string | number | boolean | null | undefined>;

type LoggerShape = {
  readonly info: (event: string, fields: LogFields) => Effect.Effect<void>;
  readonly warn: (event: string, fields: LogFields) => Effect.Effect<void>;
  readonly error: (event: string, fields: LogFields) => Effect.Effect<void>;
};

export class StructuredLogger extends Context.Service<StructuredLogger, LoggerShape>()(
  "@great-minds/server/StructuredLogger",
) {}

const emit = (level: "info" | "warn" | "error", event: string, fields: LogFields) =>
  Effect.sync(() => {
    const body: LogFields = {
      ts: new Date().toISOString(),
      level,
      event,
      ...fields,
    };
    console.log(JSON.stringify(body));
  });

export const StructuredLoggerLive = Layer.succeed(StructuredLogger, {
  info: (event, fields) => emit("info", event, fields),
  warn: (event, fields) => emit("warn", event, fields),
  error: (event, fields) => emit("error", event, fields),
});
