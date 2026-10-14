import { SessionId, Uuid } from "@great-minds/domain";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { auth } from "$lib/auth.svelte";
import Fixture from "./publication-fixture.svelte";
import { activeVault } from "./use-vault.svelte";

const uuid = (value: number) =>
  Uuid.make(`00000000-0000-4000-8000-${String(value).padStart(12, "0")}`);
const root = SessionId.make("root");
const literal = "# A complete conversation\n\n💡 धर्म\n\nAttached note";
const vaults = Array.from({ length: 51 }, (_, index) => ({
  id: uuid(index + 1),
  name: `Vault ${index + 1}`,
  owner_id: uuid(100),
  created_at: "2026-01-01T00:00:00Z",
}));
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
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
const revoked = vi.fn<(url: string) => void>();

const click = (label: string) => {
  const button = [...target.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  if (button === undefined) throw new Error(`Missing button: ${label}`);
  button.click();
  flushSync();
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
    throw new Error(`Unexpected request: ${url.pathname}`);
  };
  vi.stubGlobal("fetch", fetchImpl);
});

afterEach(async () => {
  await stop();
  for (const pending of waiting) pending.resolve(pdf());
  await vi.waitFor(() => expect(revoked).toHaveBeenCalledTimes(blobs.size));
  vi.unstubAllGlobals();
  auth.userId = null;
  auth.isAuthenticated = false;
  activeVault.id = null;
  target.remove();
});

describe("mounted publication ownership", () => {
  it("releases old artifacts, offers fresh complete Markdown after PDF failure, and cancels navigation and teardown", async () => {
    const component = start();
    await vi.waitFor(() => expect(activeVault.id).toBe(uuid(1)));
    click("Export");
    await vi.waitFor(() => expect(target.querySelector("iframe")).not.toBeNull());
    expect(blobs.size).toBe(2);
    expect(target.querySelector('a[download="research-notes.pdf"]')?.getAttribute("href")).toBe(
      target.querySelector("iframe")!.getAttribute("src"),
    );
    expect(
      blobs.has(target.querySelector('a[download="research-notes.md"]')!.getAttribute("href")!),
    ).toBe(true);
    failPdf = true;
    click("Refresh copy");
    await vi.waitFor(() =>
      expect(target.querySelector('[role="alert"]')?.textContent).toContain(
        "PDF rendering unavailable",
      ),
    );
    expect(revoked).toHaveBeenCalledTimes(2);
    expect(target.querySelector("iframe")).toBeNull();
    click("Prepare Markdown");
    await vi.waitFor(() => expect(target.textContent).toContain("Your Markdown copy is ready"));
    const markdown = target.querySelector<HTMLAnchorElement>('a[download="conversation.md"]');
    expect(markdown).not.toBeNull();
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blobs.get(markdown!.href)!);
    });
    expect(text).toBe(literal);
    expect(
      requests.filter((request) => new URL(request.url).pathname.endsWith("/markdown")),
    ).toHaveLength(1);
    auth.userId = uuid(101);
    flushSync();
    await vi.waitFor(() => expect(revoked).toHaveBeenCalledTimes(3));
    expect(target.querySelector('[aria-label="Conversation export"]')).toBeNull();

    deferPdf = true;
    click("Export");
    await vi.waitFor(() => expect(waiting).toHaveLength(1));
    component.navigate(SessionId.make("another"));
    flushSync();
    await vi.waitFor(() => expect(waiting[0]!.request.signal.aborted).toBe(true));
    waiting[0]!.resolve(pdf());
    click("Export");
    await vi.waitFor(() => expect(waiting).toHaveLength(2));
    expect(blobs.size).toBe(3);
    await stop();
    await vi.waitFor(() => expect(waiting[1]!.request.signal.aborted).toBe(true));
    waiting[1]!.resolve(pdf());
    expect(blobs.size).toBe(3);
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
