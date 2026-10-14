import { watch } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber } from "effect";
import { expect, it } from "vitest";

import { makePdfRenderer } from "../src/publication/pdf.ts";
import type { Publication } from "../src/publication/markdown.ts";

const publication = (title: string): Publication => ({
  title,
  markdown: title,
  tree: { type: "root", children: [] },
});

it("bounds compiler ownership, kills cancelled children, removes plaintext, and keeps failures private", async () => {
  const root = await mkdtemp(join(tmpdir(), "gm-pdf-lifecycle-"));
  const work = join(root, "work");
  const binary = join(root, "compiler.cjs");
  await mkdir(work);
  await writeFile(
    binary,
    `#!${process.execPath}\nconst fs = require('node:fs'); const path = require('node:path');
const root = path.dirname(path.dirname(process.cwd()));
const input = JSON.parse(fs.readFileSync('publication.json', 'utf8'));
if (process.env.DATABASE_URL || process.env.OPENROUTER_API_KEY) process.exit(7);
if (input.title === 'wait') {
  fs.writeFileSync(path.join(root, 'starting'), String(process.pid));
  fs.renameSync(path.join(root, 'starting'), path.join(root, 'started'));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), 0, 0);
} else if (input.title === 'fail') { process.stderr.write('PRIVATE_RENDER_DIAGNOSTIC'); process.exit(1); }
else { fs.writeFileSync('document.pdf', '%PDF-fixture\\n%%EOF'); }
`,
  );
  await chmod(binary, 0o700);
  let observer: ReturnType<typeof watch> | undefined;
  const started = new Promise<void>((resolve, reject) => {
    observer = watch(root, (_, name) => {
      if (name === "started") resolve();
    });
    observer.on("error", reject);
  });
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const renderer = yield* makePdfRenderer(binary, root, work);
          const running = yield* Effect.forkChild(
            renderer.render(publication("wait"), "a4", new Date()),
          );
          yield* Effect.promise(() => started);
          const pid = Number(yield* Effect.promise(() => readFile(join(root, "started"), "utf8")));
          expect(pid).toBeGreaterThan(0);
          const busy = yield* Effect.result(
            renderer.render(publication("other"), "a4", new Date()),
          );
          expect(busy).toMatchObject({ _tag: "Failure", failure: { _tag: "ServiceUnavailable" } });
          expect(yield* Effect.promise(() => readdir(work))).toHaveLength(1);
          yield* Fiber.interrupt(running);
          expect(() => process.kill(pid, 0)).toThrow();
          expect(yield* Effect.promise(() => readdir(work))).toEqual([]);
          const failed = yield* Effect.result(
            renderer.render(publication("fail"), "a4", new Date()),
          );
          expect(failed).toMatchObject({
            _tag: "Failure",
            failure: { _tag: "ServiceUnavailable" },
          });
          expect(JSON.stringify(failed)).not.toContain("PRIVATE_RENDER_DIAGNOSTIC");
          const bytes = yield* renderer.render(publication("success"), "a4", new Date());
          expect(new TextDecoder().decode(bytes)).toBe("%PDF-fixture\n%%EOF");
          expect(yield* Effect.promise(() => readdir(work))).toEqual([]);
        }),
      ),
    );
  } finally {
    observer?.close();
    await rm(root, { recursive: true, force: true });
  }
});
