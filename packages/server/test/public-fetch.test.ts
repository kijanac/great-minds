import { createServer, type Server } from "node:http";

import { Response } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fetchPublicUrl, responseTextCapped } from "../src/public-fetch.ts";

const listeningPort = (server: Server) => {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Server has no port");
  return address.port;
};

const fetchGuarded = (url: string) => fetchPublicUrl(url, { signal: AbortSignal.timeout(5_000) });

describe("fetchPublicUrl", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer((_request, response) => response.end("local secret"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = listeningPort(server);
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("blocks loopback via hostname lookup", async () => {
    await expect(fetchGuarded(`http://localhost:${port}/`)).rejects.toThrowError(/fetch failed/);
  });

  it("blocks literal loopback IPv4", async () => {
    await expect(fetchGuarded(`http://127.0.0.1:${port}/`)).rejects.toThrowError(/fetch failed/);
  });

  it("blocks literal IPv6 loopback", async () => {
    await expect(fetchGuarded(`http://[::1]:${port}/`)).rejects.toThrowError(/fetch failed/);
  });

  it("blocks IPv4-mapped IPv6 loopback", async () => {
    await expect(fetchGuarded(`http://[::ffff:127.0.0.1]:${port}/`)).rejects.toThrowError(
      /fetch failed/,
    );
  });

  it("blocks private-range and metadata literals", async () => {
    await expect(fetchGuarded("http://10.0.0.1/")).rejects.toThrowError(/fetch failed/);
    await expect(fetchGuarded("http://192.168.1.1/")).rejects.toThrowError(/fetch failed/);
    await expect(fetchGuarded("http://169.254.169.254/latest/meta-data/")).rejects.toThrowError(
      /fetch failed/,
    );
  });

  it("names the blocked host in the failure cause", async () => {
    const failure = await fetchGuarded(`http://127.0.0.1:${port}/`).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).cause)).toContain("non-public address");
  });
});

describe("responseTextCapped", () => {
  it("returns bodies within the cap", async () => {
    await expect(responseTextCapped(new Response("hello"), 1024)).resolves.toBe("hello");
  });

  it("rejects bodies over the cap", async () => {
    await expect(responseTextCapped(new Response("x".repeat(2048)), 1024)).rejects.toThrowError(
      /byte limit/,
    );
  });

  it("returns empty text for a missing body", async () => {
    await expect(responseTextCapped(new Response(null), 1024)).resolves.toBe("");
  });
});
