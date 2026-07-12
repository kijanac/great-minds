import { runGoldens } from "./orchestrator.ts";

const mode = process.argv[2];
if (mode !== "record" && mode !== "record-deferred" && mode !== "check") throw new Error("usage: main.ts record|record-deferred|check");
const started = process.hrtime.bigint();
try {
  const result = await runGoldens(mode);
  const durationMs = Number((process.hrtime.bigint() - started) / 1_000_000n);
  console.log(`Goldens ${mode.toUpperCase()} ${result.result} duration_ms=${durationMs}`);
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
}
