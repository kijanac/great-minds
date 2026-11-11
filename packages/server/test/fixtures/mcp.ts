import { Schema } from "effect";

const decodeMessage = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

export const readMcpResponse = async (response: Response) => {
  const text = await response.text();
  const data = response.headers.get("content-type")?.includes("event-stream")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter(Boolean)
        .at(-1)
    : text;
  return decodeMessage(data || "{}");
};

export const openMcp = async (baseUrl: string, token: string) => {
  const headers = new Headers({
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-06-18",
  });
  let id = 0;
  const request = async (method: string, params: unknown) => {
    const response = await fetch(`${baseUrl}/v1/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        ...(method.startsWith("notifications/") ? {} : { id: ++id }),
        method,
        params,
      }),
    });
    if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${await response.text()}`);
    const session = response.headers.get("mcp-session-id");
    if (session) headers.set("mcp-session-id", session);
    return readMcpResponse(response);
  };
  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "parity-test", version: "1" },
  });
  await request("notifications/initialized", {});
  return {
    call: (name: string, args: Record<string, unknown>) =>
      request("tools/call", { name, arguments: args }),
    list: () => request("tools/list", {}),
  };
};
