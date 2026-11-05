import { Uuid } from "@great-minds/domain";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Fixture from "./job-sse-fixture.svelte";

const jobId = Uuid.make("00000000-0000-4000-8000-000000000001");
const vaultId = Uuid.make("00000000-0000-4000-8000-000000000002");
const snapshot = (job_status: string, phase: string, phase_status: string) =>
  `data: ${JSON.stringify({
    id: jobId,
    vault_id: vaultId,
    trigger: "manual",
    job_status,
    phase,
    phase_status,
    stages: [],
    warnings: [],
    track: [],
    outcome: null,
    created_at: "2026-11-04T17:25:44.000Z",
    updated_at: null,
    completed_at: null,
  })}\n\n`;
const events = (frames: string) =>
  new Response(frames, { headers: { "content-type": "text/event-stream" } });

let target: HTMLDivElement;
let responses: (() => Response)[];

beforeEach(() => {
  target = document.createElement("div");
  document.body.append(target);
  localStorage.setItem("access_token", "fixture-only");
  responses = [];
  vi.stubGlobal("fetch", async () => {
    const next = responses.shift();
    if (next === undefined) throw new Error("Unexpected request");
    return next();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  target.remove();
});

describe("job progress stream", () => {
  it("reports a lost stream apart from the run's own state and follows the run again on reconnect", async () => {
    responses.push(
      () => events(snapshot("running", "extract", "running")),
      () => new Response("Internal Server Error", { status: 500 }),
      () => events(snapshot("completed", "publish", "completed")),
    );
    const component = mount(Fixture, { target, props: { jobId, vaultId } });
    const output = () => target.querySelector("output")!;

    await vi.waitFor(() => expect(output().dataset.streamError).toBe("Request failed (500)"), {
      timeout: 5_000,
    });
    expect(output().dataset.error).toBe("");
    expect(output().dataset.done).toBe("false");

    target.querySelector("button")!.click();
    flushSync();
    await vi.waitFor(() => expect(output().dataset.done).toBe("true"));
    expect(output().dataset.streamError).toBe("");
    expect(output().dataset.error).toBe("");
    await unmount(component);
  }, 10_000);
});
