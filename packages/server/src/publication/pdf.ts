import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ServiceUnavailable, type PublicationPaper } from "@great-minds/domain";
import { Context, Effect, Layer, Option, Semaphore } from "effect";

import { AppConfig } from "../config.ts";
import { publicationFonts } from "./assets.ts";
import type { Publication } from "./markdown.ts";

export interface PdfRendererShape {
  readonly render: (
    publication: Publication,
    paper: PublicationPaper,
    createdAt: Date,
  ) => Effect.Effect<Uint8Array, ServiceUnavailable>;
}

export class PdfRenderer extends Context.Service<PdfRenderer, PdfRendererShape>()(
  "@great-minds/server/PdfRenderer",
) {}

const template = fileURLToPath(new URL("./document.typ", import.meta.url));
const unavailable = () =>
  new ServiceUnavailable({
    detail:
      "The PDF could not be prepared. Try again, or contact the server administrator if this continues.",
  });
const io = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: unavailable }).pipe(Effect.uninterruptible);

const runCompiler = (binary: string, directory: string, fonts: string, createdAt: Date) =>
  Effect.callback<void, ServiceUnavailable>((resume) => {
    const child = spawn(
      binary,
      [
        "compile",
        "--root",
        directory,
        "--font-path",
        fonts,
        "--ignore-system-fonts",
        "--ignore-embedded-fonts",
        "--package-path",
        join(directory, "packages"),
        "--package-cache-path",
        join(directory, "packages"),
        "--pdf-standard",
        "ua-1",
        "--jobs",
        "1",
        "--creation-timestamp",
        String(Math.floor(createdAt.getTime() / 1000)),
        "document.typ",
        "document.pdf",
      ],
      {
        cwd: directory,
        env: { PATH: process.env.PATH, LANG: "C.UTF-8", HOME: directory },
        stdio: "ignore",
      },
    );
    let closed = false;
    let failed = false;
    const finished = new Promise<void>((resolve) => {
      child.once("error", () => {
        failed = true;
      });
      child.once("close", (code) => {
        closed = true;
        resolve();
        resume(code === 0 && !failed ? Effect.void : Effect.fail(unavailable()));
      });
    });
    return Effect.promise(async () => {
      if (!closed) child.kill("SIGKILL");
      await finished;
    });
  });

export const makePdfRenderer = (
  binary: string,
  fonts = publicationFonts,
  temporaryRoot = tmpdir(),
) =>
  Effect.gen(function* () {
    const gate = yield* Semaphore.make(1);
    return {
      render: (publication: Publication, paper: PublicationPaper, createdAt: Date) =>
        Effect.gen(function* () {
          const result = yield* gate.withPermitsIfAvailable(1)(
            Effect.scoped(
              Effect.gen(function* () {
                const directory = yield* Effect.acquireRelease(
                  io(() => mkdtemp(join(temporaryRoot, "great-minds-pdf-"))),
                  (path) => io(() => rm(path, { recursive: true, force: true })).pipe(Effect.orDie),
                );
                yield* io(() => mkdir(join(directory, "packages")));
                yield* io(() => copyFile(template, join(directory, "document.typ")));
                yield* io(() =>
                  writeFile(
                    join(directory, "publication.json"),
                    JSON.stringify({ title: publication.title, tree: publication.tree, paper }),
                    { mode: 0o600, flag: "wx" },
                  ),
                );
                yield* runCompiler(binary, directory, fonts, createdAt);
                const bytes = yield* io(() => readFile(join(directory, "document.pdf")));
                if (bytes.subarray(0, 5).toString() !== "%PDF-") return yield* unavailable();
                return new Uint8Array(bytes);
              }),
            ),
          );
          if (Option.isNone(result))
            return yield* new ServiceUnavailable({
              detail: "Another PDF is being prepared. Try exporting again shortly.",
            });
          return result.value;
        }),
    } satisfies PdfRendererShape;
  });

const makeConfiguredPdfRenderer = Effect.gen(function* () {
  const config = yield* AppConfig;
  return yield* makePdfRenderer(config.typstBinary);
});

export const PdfRendererLive = Layer.effect(PdfRenderer, makeConfiguredPdfRenderer);
