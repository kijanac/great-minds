import { runParity } from "./orchestrator.ts";

try {
  const result = await runParity();
  console.log(result.summary);
  console.log(`report=${result.reportPath}`);
  const failures = result.report.requests.filter((request) => !request.result.ok);
  if (failures.length > 0) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
