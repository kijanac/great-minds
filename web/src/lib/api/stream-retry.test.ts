import { afterEach, describe, expect, it, vi } from "vitest";

import { abortableSleep, retryDelay } from "./stream-retry";

afterEach(() => {
  vi.useRealTimers();
});

describe("stream reconnect timing", () => {
  it.each([
    [0, 1_000],
    [1, 2_000],
    [2, 4_000],
    [3, 8_000],
    [4, 10_000],
    [8, 10_000],
  ])("backs attempt %i off by %i ms", (attempt, expected) => {
    expect(retryDelay(attempt)).toBe(expected);
  });

  it("finishes immediately and clears its timer when aborted", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const sleeping = abortableSleep(10_000, controller.signal);

    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    await sleeping;

    expect(vi.getTimerCount()).toBe(0);
  });

  it("finishes normally when its timer elapses", async () => {
    vi.useFakeTimers();
    const sleeping = abortableSleep(1_000);

    await vi.advanceTimersByTimeAsync(1_000);
    await sleeping;

    expect(vi.getTimerCount()).toBe(0);
  });
});
