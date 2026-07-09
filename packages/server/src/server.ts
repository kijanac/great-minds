import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { Effect, Fiber, Schema } from "effect";

import { AuthenticatedUser, RequestCodeInput, VerifyCodeInput } from "@great-minds/domain";

import { issueTokens, randomCode, stableSpikeUser, verifyAccessToken } from "./jwt.ts";
import { runOpenRouterSse } from "./openrouter-loop.ts";

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

const writeJson = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, jsonHeaders);
  response.end(JSON.stringify(body));
};

const writeNoContent = (response: ServerResponse) => {
  response.writeHead(204, { "cache-control": "no-store" });
  response.end();
};

const readJsonBody = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as unknown) : {};
};

const bearerToken = (request: IncomingMessage) => {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    throw new Error("Missing bearer token");
  }
  return authorization.slice("Bearer ".length);
};

const handleAuth = async (
  request: IncomingMessage,
  response: ServerResponse,
  path: string
) => {
  if (request.method === "POST" && path === "/auth/request-code") {
    const payload = Schema.decodeUnknownSync(RequestCodeInput)(await readJsonBody(request));
    randomCode();
    console.log(`[auth] stubbed request code for ${payload.email}`);
    writeNoContent(response);
    return true;
  }

  if (request.method === "POST" && path === "/auth/verify-code") {
    const payload = Schema.decodeUnknownSync(VerifyCodeInput)(await readJsonBody(request));
    const user = stableSpikeUser(payload.email);
    writeJson(response, 200, issueTokens(user));
    return true;
  }

  if (request.method === "GET" && path === "/auth/me") {
    const user = verifyAccessToken(bearerToken(request));
    Schema.decodeUnknownSync(AuthenticatedUser)(user);
    writeJson(response, 200, user);
    return true;
  }

  return false;
};

const handleSse = (request: IncomingMessage, response: ServerResponse) => {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  response.write(": connected\n\n");

  let done = false;
  let clientClosed = false;
  const fiber = Effect.runFork(runOpenRouterSse(response));

  request.on("close", () => {
    if (!done) {
      clientClosed = true;
      console.log("[sse] client closed connection; interrupting server fiber");
      Effect.runFork(Fiber.interrupt(fiber));
    }
  });

  Effect.runPromise(Fiber.join(fiber)).then(
    () => {
      done = true;
      console.log(`[sse] server fiber completed clientClosed=${clientClosed}`);
      response.end();
    },
    (error: unknown) => {
      done = true;
      if (clientClosed) {
        console.log("[sse] server fiber interrupted after client disconnect");
        return;
      }
      console.error("[sse] server fiber failed", error);
      if (!response.destroyed) {
        response.write(`event: error\ndata: ${JSON.stringify({ message: "SSE failed" })}\n\n`);
        response.end();
      }
    }
  );
};

export const startServer = (port = Number(process.env.PORT ?? 8787)): Server => {
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
        if (request.method === "GET" && url.pathname === "/health") {
          writeJson(response, 200, { ok: true });
          return;
        }
        if (request.method === "GET" && url.pathname === "/query/stream") {
          handleSse(request, response);
          return;
        }
        if (await handleAuth(request, response, url.pathname)) {
          return;
        }
        writeJson(response, 404, { error: "not_found" });
      } catch (error) {
        writeJson(response, 400, {
          error: "bad_request",
          message: error instanceof Error ? error.message : "unknown error"
        });
      }
    })();
  });

  server.listen(port, () => {
    console.log(`[server] listening on http://localhost:${port}`);
  });
  return server;
};
