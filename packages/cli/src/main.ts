#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Cause, Effect, Layer } from "effect";
import { CliError } from "effect/unstable/cli";

import { runGm } from "./cli.ts";
import { userMessage } from "./commands.ts";
import { CliFetch } from "./connection.ts";
import { CredentialsLive } from "./credentials.ts";
import { OutputLive } from "./output.ts";

const MainLive = Layer.mergeAll(
  CredentialsLive,
  OutputLive,
  Layer.succeed(CliFetch, (input, init) => fetch(input, init)),
).pipe(Layer.provideMerge(NodeServices.layer));

const program = runGm(process.argv.slice(2)).pipe(
  Effect.catchCause((cause) =>
    Effect.sync(() => {
      const failure = Cause.squash(cause);
      if (!CliError.isCliError(failure)) process.stderr.write(`gm: ${userMessage(failure)}\n`);
      process.exitCode = 1;
    }),
  ),
  Effect.provide(MainLive),
);

NodeRuntime.runMain(program, { disableErrorReporting: true });
