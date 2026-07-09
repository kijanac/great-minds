const port = process.env.PORT ?? "8787";
const abortEarly = process.argv.includes("--abort");
const controller = new AbortController();
const started = performance.now();
let chunks = 0;

const response = await fetch(`http://localhost:${port}/query/stream`, {
  signal: controller.signal
});

if (!response.body) {
  throw new Error("Response body is missing");
}

console.log(`[client] status=${response.status}`);

const reader = response.body.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) {
    break;
  }
  chunks += 1;
  const elapsed = Math.round(performance.now() - started);
  console.log(`[client] chunk=${chunks} at=${elapsed}ms bytes=${value.byteLength}`);
  process.stdout.write(decoder.decode(value, { stream: true }));
  if (abortEarly && chunks >= 1) {
    console.log("[client] aborting stream");
    controller.abort();
    break;
  }
}

console.log(`[client] complete chunks=${chunks}`);
