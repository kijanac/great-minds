import { Forbidden, Unauthorized, Uuid } from "@great-minds/domain";
import { Effect, Layer, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { ApiError, makeApi } from "./runtime";
import { TokenStore, type StoredTokens } from "./token-store";

const vaultId = Schema.decodeSync(Uuid)("018f6a2e-0000-7000-8000-000000000001");
const baseUrl = "http://test.local/api";

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly body: string;
}

function memoryTokens(initial: StoredTokens) {
  const state = { ...initial };
  const layer = Layer.succeed(TokenStore, {
    read: Effect.sync(() => ({ ...state })),
    write: (tokens) =>
      Effect.sync(() => {
        state.access = tokens.access_token;
        state.refresh = tokens.refresh_token;
      }),
    clear: Effect.sync(() => {
      state.access = null;
      state.refresh = null;
    }),
  });
  return { layer, state };
}

function fetchResponding(respond: (request: RecordedRequest) => Response | Promise<Response>) {
  const requests: RecordedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const recorded = {
      url: request.url,
      method: request.method,
      authorization: request.headers.get("authorization"),
      body: await request.text(),
    };
    requests.push(recorded);
    return respond(recorded);
  };
  return { fetchImpl, requests };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const vaultDetail = {
  id: vaultId,
  name: "Research",
  owner_id: vaultId,
  created_at: "2026-08-28T00:00:00Z",
  role: "owner",
  member_count: 1,
  article_count: 3,
};

const tokenPair = (suffix: string) => ({
  access_token: `access-${suffix}`,
  refresh_token: `refresh-${suffix}`,
  token_type: "bearer" as const,
});

const unauthorized = () => json(401, { _tag: "Unauthorized", detail: "Token expired" });

describe("makeApi", () => {
  it("attaches the stored bearer token and decodes the contract response", async () => {
    const { fetchImpl, requests } = fetchResponding(() => json(200, vaultDetail));
    const tokens = memoryTokens({ access: "access-1", refresh: "refresh-1" });
    const { api, run } = makeApi({ baseUrl, fetch: fetchImpl, tokens: tokens.layer });

    const detail = await run(api.vaults.getVault({ params: { vault_id: vaultId } }));

    expect(detail).toEqual(vaultDetail);
    expect(requests).toEqual([
      {
        url: `http://test.local/api/vaults/${vaultId}`,
        method: "GET",
        authorization: "Bearer access-1",
        body: "",
      },
    ]);
  });

  it("refreshes once on 401 and retries with the renewed token", async () => {
    const { fetchImpl, requests } = fetchResponding((request) => {
      if (request.url.endsWith("/auth/refresh")) return json(200, tokenPair("2"));
      return request.authorization === "Bearer access-2" ? json(200, vaultDetail) : unauthorized();
    });
    const tokens = memoryTokens({ access: "access-1", refresh: "refresh-1" });
    const { api, run } = makeApi({ baseUrl, fetch: fetchImpl, tokens: tokens.layer });

    const detail = await run(api.vaults.getVault({ params: { vault_id: vaultId } }));

    expect(detail).toEqual(vaultDetail);
    expect(requests.map((request) => [request.method, request.authorization])).toEqual([
      ["GET", "Bearer access-1"],
      ["POST", null],
      ["GET", "Bearer access-2"],
    ]);
    expect(requests[1].body).toBe(JSON.stringify({ refresh_token: "refresh-1" }));
    expect(tokens.state).toEqual({ access: "access-2", refresh: "refresh-2" });
  });

  it("shares one refresh across concurrent 401s", async () => {
    let refreshes = 0;
    const { fetchImpl } = fetchResponding((request) => {
      if (request.url.endsWith("/auth/refresh")) {
        refreshes += 1;
        return json(200, tokenPair("2"));
      }
      return request.authorization === "Bearer access-2" ? json(200, vaultDetail) : unauthorized();
    });
    const tokens = memoryTokens({ access: "access-1", refresh: "refresh-1" });
    const { api, run } = makeApi({ baseUrl, fetch: fetchImpl, tokens: tokens.layer });
    const getVault = () => run(api.vaults.getVault({ params: { vault_id: vaultId } }));

    await Promise.all([getVault(), getVault(), getVault()]);

    expect(refreshes).toBe(1);
  });

  it("clears the session and surfaces Unauthorized when refresh is rejected", async () => {
    const { fetchImpl } = fetchResponding((request) =>
      request.url.endsWith("/auth/refresh")
        ? json(401, { _tag: "Unauthorized", detail: "Invalid or expired refresh token" })
        : unauthorized(),
    );
    const tokens = memoryTokens({ access: "access-1", refresh: "refresh-1" });
    const { api, run } = makeApi({ baseUrl, fetch: fetchImpl, tokens: tokens.layer });

    const failure = await run(api.vaults.getVault({ params: { vault_id: vaultId } })).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Unauthorized);
    expect(tokens.state).toEqual({ access: null, refresh: null });
  });

  it("keeps the session when renewal fails for a non-auth reason", async () => {
    const { fetchImpl } = fetchResponding((request) =>
      request.url.endsWith("/auth/refresh")
        ? Promise.reject(new TypeError("offline"))
        : unauthorized(),
    );
    const tokens = memoryTokens({ access: "access-1", refresh: "refresh-1" });
    const { api, run } = makeApi({ baseUrl, fetch: fetchImpl, tokens: tokens.layer });

    const failure = await run(api.vaults.getVault({ params: { vault_id: vaultId } })).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Unauthorized);
    expect(tokens.state).toEqual({ access: "access-1", refresh: "refresh-1" });
  });

  it("decodes declared errors into catchable domain errors", async () => {
    const { fetchImpl } = fetchResponding(() =>
      json(403, { _tag: "Forbidden", detail: "Only vault members can perform this action" }),
    );
    const tokens = memoryTokens({ access: "access-1", refresh: "refresh-1" });
    const { api, run } = makeApi({ baseUrl, fetch: fetchImpl, tokens: tokens.layer });

    const recovered = await run(
      api.vaults
        .getVault({ params: { vault_id: vaultId } })
        .pipe(Effect.catchTag("Forbidden", (error) => Effect.succeed(error.detail))),
    );

    expect(recovered).toBe("Only vault members can perform this action");
    const failure = await run(api.vaults.getVault({ params: { vault_id: vaultId } })).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Forbidden);
  });

  it("maps undeclared statuses and transport failures to ApiError", async () => {
    const tokens = memoryTokens({ access: "access-1", refresh: "refresh-1" });
    const server = fetchResponding(() => json(500, { detail: "hidden" }));
    const offline = fetchResponding(() => Promise.reject(new TypeError("offline")));

    const onServer = makeApi({ baseUrl, fetch: server.fetchImpl, tokens: tokens.layer });
    const whenOffline = makeApi({ baseUrl, fetch: offline.fetchImpl, tokens: tokens.layer });
    const getVault = ({ api, run }: typeof onServer) =>
      run(api.vaults.getVault({ params: { vault_id: vaultId } })).catch((error: unknown) => error);

    const serverFailure = await getVault(onServer);
    const offlineFailure = await getVault(whenOffline);

    expect(serverFailure).toBeInstanceOf(ApiError);
    expect((serverFailure as ApiError).message).toBe("Request failed (500)");
    expect((offlineFailure as ApiError).message).toBe("Network error");
  });

  it("sends unauthenticated requests without a bearer and returns the 401 as Unauthorized", async () => {
    const { fetchImpl, requests } = fetchResponding(() => unauthorized());
    const tokens = memoryTokens({ access: null, refresh: null });
    const { api, run } = makeApi({ baseUrl, fetch: fetchImpl, tokens: tokens.layer });

    const failure = await run(api.vaults.getVault({ params: { vault_id: vaultId } })).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Unauthorized);
    expect(requests.map((request) => request.authorization)).toEqual([null]);
  });
});

const sseResponse = (frames: readonly string[], onCancel?: () => void) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
      cancel() {
        onCancel?.();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

const openEnded = (frames: readonly string[], onCancel?: () => void) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
      },
      cancel() {
        onCancel?.();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

async function collect<A>(iterable: AsyncIterable<A>): Promise<A[]> {
  const items: A[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

describe("makeApi streams", () => {
  it("decodes server-sent events from a contract stream endpoint", async () => {
    const { fetchImpl, requests } = fetchResponding(() =>
      sseResponse([
        "event: connected\ndata: {}\n\n",
        'data: {"n":1}\n\n',
        "event: done\ndata: \n\n",
      ]),
    );
    const tokens = memoryTokens({ access: "access-1", refresh: "refresh-1" });
    const { api, stream } = makeApi({ baseUrl, fetch: fetchImpl, tokens: tokens.layer });

    const events = await collect(
      stream(Stream.unwrap(api.jobs.streamJob({ params: { vault_id: vaultId, job_id: vaultId } }))),
    );

    expect(events.map((event) => [event.event, event.data])).toEqual([
      ["connected", "{}"],
      ["message", '{"n":1}'],
      ["done", ""],
    ]);
    expect(requests[0].authorization).toBe("Bearer access-1");
  });

  it("rejects the iteration with AbortError when the abort signal fires", async () => {
    let cancelled = false;
    const { fetchImpl } = fetchResponding(() =>
      openEnded(['data: {"n":1}\n\n'], () => {
        cancelled = true;
      }),
    );
    const tokens = memoryTokens({ access: "access-1", refresh: "refresh-1" });
    const { api, stream } = makeApi({ baseUrl, fetch: fetchImpl, tokens: tokens.layer });
    const controller = new AbortController();

    const seen: string[] = [];
    const consume = async () => {
      for await (const event of stream(
        Stream.unwrap(api.jobs.streamJob({ params: { vault_id: vaultId, job_id: vaultId } })),
        controller.signal,
      )) {
        seen.push(event.data);
        controller.abort();
      }
    };

    await expect(consume()).rejects.toMatchObject({ name: "AbortError" });
    expect(seen).toEqual(['{"n":1}']);
    expect(cancelled).toBe(true);
  });

  it("rejects an aborted request as an interruption", async () => {
    const { fetchImpl } = fetchResponding(() => new Promise<Response>(() => undefined));
    const tokens = memoryTokens({ access: "access-1", refresh: "refresh-1" });
    const { api, run } = makeApi({ baseUrl, fetch: fetchImpl, tokens: tokens.layer });
    const controller = new AbortController();

    const pending = run(api.vaults.getVault({ params: { vault_id: vaultId } }), {
      signal: controller.signal,
    }).catch((error: unknown) => error);
    controller.abort();
    const failure = await pending;

    expect((failure as Error).name).toBe("AbortError");
    expect(failure).toBeInstanceOf(Error);
  });
});
