#!/usr/bin/env node
import { readFileSync } from "node:fs";

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { errorMessage } from "@great-minds/client";
import { Cause, Effect, Layer } from "effect";
import { CliError } from "effect/cli";

import { runGm } from "./cli.ts";
import { CliFetch } from "./connection.ts";
import { CredentialsLive } from "./credentials.ts";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const MainLive = Layer.mergeAll(
  CredentialsLive,
  Layer.succeed(CliFetch, (input, init) => fetch(input, init)),
).pipe(Layer.provideMerge(NodeServices.layer));

const program = runGm(process.argv.slice(2), String(version)).pipe(
  Effect.catchCause((cause) => {
    if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
    const failure = Cause.squash(cause);
    return Effect.sync(() => {
      if (CliError.isCliError(failure)) {
        if (failure._tag !== "ShowHelp" || failure.errors.length > 0) process.exitCode = 1;
        return;
      }
      process.stderr.write(`gm: ${errorMessage(failure)}\n`);
      process.exitCode = 1;
    });
  }),
  Effect.provide(MainLive),
);

NodeRuntime.runMain(program, { disableErrorReporting: true });
