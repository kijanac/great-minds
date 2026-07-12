import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";

export type Child = { readonly process: ChildProcess; readonly log: WriteStream; readonly close: () => Promise<void> };

export const run = (command: string, args: readonly string[], options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly allowFailure?: boolean }) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 || options.allowFailure === true ? resolve() : reject(new Error(`${command} exited ${code ?? "unknown"}\n${output}`)));
  });

export const output = (command: string, args: readonly string[], options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv }) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(stdout) : reject(new Error(`${command} exited ${code ?? "unknown"}\n${stderr}`)));
  });

export const start = (name: string, command: string, args: readonly string[], options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly logDir: string }): Child => {
  const log = createWriteStream(`${options.logDir}/${name}.log`, { flags: "a" });
  const process = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
  process.stdout.pipe(log, { end: false });
  process.stderr.pipe(log, { end: false });
  return { process, log, close: async () => {
    if (process.exitCode === null && process.signalCode === null) process.kill("SIGTERM");
    await new Promise<void>((resolve) => process.exitCode === null ? process.once("exit", () => resolve()) : resolve());
    await new Promise<void>((resolve) => log.end(resolve));
  } };
};
