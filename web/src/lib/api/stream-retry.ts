export function retryDelay(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 10_000);
}

export function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timeout = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", finish, { once: true });
  });
}
