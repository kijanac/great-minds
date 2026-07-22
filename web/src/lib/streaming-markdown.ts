const fencePattern = /^ {0,3}(```|~~~)/;

export function splitStreamingMarkdown(text: string): { stable: string; tail: string } {
  let boundary = 0;
  let inFence = false;
  let lineStart = 0;

  while (lineStart < text.length) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(lineStart, lineEnd).replace(/\r$/, "");

    if (fencePattern.test(line)) {
      inFence = !inFence;
    } else if (!inFence && line.trim() === "") {
      boundary = newline === -1 ? text.length : newline + 1;
    }

    if (newline === -1) break;
    lineStart = newline + 1;
  }

  return {
    stable: text.slice(0, boundary),
    tail: text.slice(boundary),
  };
}
