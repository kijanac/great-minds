import { SessionId, Uuid } from "@great-minds/domain";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { auth } from "#lib/auth.svelte.ts";
import Fixture from "./publication-fixture.svelte";
import { activeVault } from "./use-vault.svelte";

const uuid = (value: number) =>
  Uuid.make(`00000000-0000-4000-8000-${String(value).padStart(12, "0")}`);
const root = SessionId.make("root");
const literal = "# A complete conversation\n\n💡 धर्म\n\nAttached note";
const savedSession = {
  id: root,
  kind: "session",
  activity: null,
  origin_title: null,
  threads: [],
  events: [1, 2, 3].map((index) => ({
    type: "exchange",
    exId: uuid(index),
    reply_id: uuid(index + 10),
    version: 1,
    status: "completed",
    error: null,
    query: `Question ${index}`,
    answer: `Answer ${index}`,
    ts: "2026-01-01T00:00:00Z",
  })),
};
const vaults = Array.from({ length: 51 }, (_, index) => ({
  id: uuid(index + 1),
  name: `Vault ${index + 1}`,
  owner_id: uuid(100),
  created_at: "2026-01-01T00:00:00Z",
}));
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const pdf = () =>
  json({
    title: "Research notes",
    prepared_at: "2026-01-01T00:00:00Z",
    paper: "a4",
    markdown: literal,
    pdf: btoa("%PDF-fixture"),
  });
let target: HTMLDivElement;
let dispose: () => Promise<void>;
let failPdf: boolean;
let deferPdf: boolean;
let requests: Request[];
let waiting: { request: Request; resolve: (response: Response) => void }[];
let blobs: Map<string, Blob>;
let downloads: { href: string; filename: string }[];
const revoked = vi.fn<(url: string) => void>();
const checkboxes = () => [...target.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
const click = (label: string) => {
  const button = [
    ...target.querySelectorAll<HTMLButtonElement | HTMLAnchorElement>("button,a"),
  ].find((element) => element.textContent?.trim() === label);
  if (button === undefined) throw new Error(`Missing button: ${label}`);
  button.click();
  flushSync();
};
const chooseFormat = (format: "pdf" | "markdown") => {
  const select = target.querySelector("select")!;
  select.value = format;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  flushSync();
};
const openSelection = async () => {
  click("Export");
  await vi.waitFor(() => expect(checkboxes()).toHaveLength(7));
};
const start = (linkedVault: string | null = null) => {
  const component = mount(Fixture, { target, props: { sessionId: root, linkedVault } });
  dispose = () => unmount(component);
  flushSync();
  return component;
};
const stop = async () => {
  const cleanup = dispose;
  dispose = async () => {};
  await cleanup();
};

beforeEach(() => {
  target = document.createElement("div");
  document.body.append(target);
  dispose = async () => {};
  requests = [];
  waiting = [];
  downloads = [];
  blobs = new Map();
  revoked.mockClear();
  failPdf = false;
  deferPdf = false;
  localStorage.clear();
  localStorage.setItem("access_token", "fixture-only");
  localStorage.setItem("vault_id", uuid(1));
  auth.isAuthenticated = true;
  auth.userId = uuid(100);
  activeVault.id = null;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloads.push({ href: this.href, filename: this.download });
  });
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL(blob: Blob) {
        const url = `blob:publication-${blobs.size + 1}`;
        blobs.set(url, blob);
        return url;
      }
      static revokeObjectURL = revoked;
    },
  );
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      location.origin,
    );
    const request = new Request(url, init);
    requests.push(request);
    if (url.pathname.endsWith("/vaults")) {
      const offset = Number(url.searchParams.get("offset"));
      return json({
        items: vaults.slice(offset, offset + 50),
        pagination: { limit: 50, offset, total: offset === 0 ? 51 : 1000 },
        roles: {},
      });
    }
    if (url.pathname.endsWith("/export")) {
      if (deferPdf)
        return new Promise<Response>((resolve) => {
          waiting.push({ request, resolve });
        });
      return failPdf
        ? json({ _tag: "ServiceUnavailable", detail: "PDF rendering unavailable" }, 503)
        : pdf();
    }
    if (url.pathname.endsWith("/markdown"))
      return new Response(literal, { headers: { "content-type": "text/markdown" } });
    if (/\/sessions\/[^/]+$/u.test(url.pathname)) return json(savedSession);
    throw new Error(`Unexpected request: ${url.pathname}`);
  };
  vi.stubGlobal("fetch", fetchImpl);
});

afterEach(async () => {
  await stop();
  for (const pending of waiting) pending.resolve(pdf());
  await vi.waitFor(() => expect(revoked).toHaveBeenCalledTimes(blobs.size));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  auth.userId = null;
  auth.isAuthenticated = false;
  activeVault.id = null;
  target.remove();
});

describe("mounted publication ownership", () => {
  it("keeps selection visible during preparation, falls back to Markdown, and cancels navigation and teardown", async () => {
    const component = start();
    await vi.waitFor(() => expect(activeVault.id).toBe(uuid(1)));
    await openSelection();
    failPdf = true;
    click("Download PDF");
    await vi.waitFor(() =>
      expect(target.querySelector('[role="alert"]')?.textContent).toContain(
        "PDF rendering unavailable",
      ),
    );
    expect(target.querySelector("iframe")).toBeNull();
    expect(checkboxes()).toHaveLength(7);
    chooseFormat("markdown");
    expect(target.querySelectorAll("select")).toHaveLength(1);
    click("Download Markdown");
    await vi.waitFor(() => expect(downloads).toHaveLength(1));
    const downloaded = downloads[0]!;
    expect(downloaded.filename).toBe("conversation.md");
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blobs.get(downloaded.href)!);
    });
    expect(text).toBe(literal);
    expect(target.querySelector('a[download="conversation.md"]')?.getAttribute("href")).toBe(
      downloaded.href,
    );
    auth.userId = uuid(101);
    flushSync();
    await vi.waitFor(() => expect(revoked).toHaveBeenCalledTimes(1));
    expect(target.querySelector('[aria-label="Conversation export"]')).toBeNull();

    deferPdf = true;
    await openSelection();
    chooseFormat("pdf");
    click("Preview");
    await vi.waitFor(() => expect(waiting).toHaveLength(1));
    expect(target.textContent).toContain("Preparing PDF…");
    expect(checkboxes().every((input) => input.disabled)).toBe(true);
    expect(target.querySelector("ol")?.closest("[hidden]")).toBeNull();
    component.navigate(SessionId.make("another"));
    flushSync();
    await vi.waitFor(() => expect(waiting[0]!.request.signal.aborted).toBe(true));
    waiting[0]!.resolve(pdf());
    await openSelection();
    click("Download PDF");
    await vi.waitFor(() => expect(waiting).toHaveLength(2));
    await stop();
    await vi.waitFor(() => expect(waiting[1]!.request.signal.aborted).toBe(true));
    waiting[1]!.resolve(pdf());
    expect(blobs.size).toBe(1);
    expect(downloads).toHaveLength(1);
  });

  it("downloads independent selections directly, reuses the preview, and invalidates changed selections", async () => {
    start();
    await vi.waitFor(() => expect(activeVault.id).toBe(uuid(1)));
    await openSelection();
    expect(checkboxes().every((input) => input.checked)).toBe(true);
    expect(requests.some((request) => request.url.endsWith("/export"))).toBe(false);
    checkboxes()[0]!.click();
    flushSync();
    expect(checkboxes().every((input) => !input.checked)).toBe(true);
    expect(
      [...target.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Download PDF",
      )?.disabled,
    ).toBe(true);
    for (const index of [2, 3, 6]) checkboxes()[index]!.click();
    flushSync();
    expect(checkboxes()[0]!.indeterminate).toBe(true);
    click("Download PDF");
    await vi.waitFor(() => expect(downloads).toHaveLength(1));
    expect(target.querySelector("iframe")).toBeNull();
    expect(downloads[0]!.filename).toBe("research-notes.pdf");
    const messages = [
      { session_id: root, exchange_id: uuid(1), role: "assistant" },
      { session_id: root, exchange_id: uuid(2), role: "user" },
      { session_id: root, exchange_id: uuid(3), role: "assistant" },
    ];
    expect(
      await requests
        .find((request) => request.url.endsWith("/export"))!
        .clone()
        .json(),
    ).toEqual({ paper: "a4", messages });
    const list = target.querySelector("ol");
    const scroller = list!.parentElement!.parentElement!;
    scroller.scrollTop = 120;
    click("Preview");
    expect(target.querySelector("iframe")?.getAttribute("src")).toContain(downloads[0]!.href);
    expect(requests.filter((request) => request.url.endsWith("/export"))).toHaveLength(1);
    click("Download PDF");
    expect(downloads).toHaveLength(2);
    expect(downloads[1]).toEqual(downloads[0]);
    click("Back");
    await vi.waitFor(() => expect(document.activeElement?.textContent?.trim()).toBe("Preview"));
    expect(target.querySelector("ol")).toBe(list);
    expect(scroller.scrollTop).toBe(120);
    expect(
      checkboxes()
        .slice(1)
        .map((input) => input.checked),
    ).toEqual([false, true, true, false, false, true]);
    chooseFormat("markdown");
    await vi.waitFor(() => expect(revoked).toHaveBeenCalledTimes(1));
    click("Download Markdown");
    await vi.waitFor(() => expect(downloads).toHaveLength(3));
    const request = requests.find((entry) => entry.url.endsWith("/markdown"))!;
    expect(request.method).toBe("POST");
    expect(await request.json()).toEqual({ messages });
    checkboxes()[0]!.click();
    flushSync();
    expect(checkboxes().every((input) => input.checked)).toBe(true);
    expect(checkboxes()[0]!.indeterminate).toBe(false);
    expect(target.querySelector("a[download]")).toBeNull();
    await vi.waitFor(() => expect(revoked).toHaveBeenCalledTimes(2));
    chooseFormat("pdf");
    const paper = target.querySelectorAll("select")[1]!;
    paper.value = "us-letter";
    paper.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
    expect(requests.filter((entry) => entry.url.endsWith("/export"))).toHaveLength(1);
    click("Preview");
    await vi.waitFor(() => expect(target.querySelector("iframe")).not.toBeNull());
    expect(
      await requests
        .filter((entry) => entry.url.endsWith("/export"))
        .at(-1)!
        .json(),
    ).toMatchObject({ paper: "us-letter" });
    click("Back");
    click("Back");
    await openSelection();
    expect(checkboxes().every((input) => input.checked)).toBe(true);
  });

  it("keeps an authorized linked vault beyond the first page selected and refuses an absent membership", async () => {
    const component = start(uuid(51));
    await vi.waitFor(() => expect(target.querySelector("output")?.dataset.pending).toBe("false"));
    expect(target.querySelector("output")?.dataset.vault).toBe(uuid(51));
    expect(activeVault.id).toBe(uuid(51));
    expect(localStorage.getItem("vault_id")).toBe(uuid(51));
    expect(
      requests
        .filter((request) => new URL(request.url).pathname.endsWith("/vaults"))
        .map((request) => new URL(request.url).searchParams.get("offset")),
    ).toEqual(["0", "50"]);
    component.navigate(root, uuid(52));
    flushSync();
    await vi.waitFor(() =>
      expect(target.querySelector("output")?.textContent).toContain("don’t have access"),
    );
    expect(activeVault.id).toBe(uuid(51));
    component.navigate(root);
    flushSync();
    expect(target.querySelector("output")?.dataset.vault).toBe(uuid(51));
  });
});
