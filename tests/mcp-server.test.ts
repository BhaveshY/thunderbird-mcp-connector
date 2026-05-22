import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

describe("MCP server", () => {
  it("responds to discovery, initialize, cached lists, and disconnected status", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "thunderbird-mcp-server-test-"));
    try {
      const responses = await runMcpRequests(
        [
          { jsonrpc: "2.0", method: "ping", params: {} },
          { jsonrpc: "2.0", id: 1, method: "server/discover", params: {} },
          {
            jsonrpc: "2.0",
            id: 2,
            method: "initialize",
            params: { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "test", version: "0" } }
          },
          {
            jsonrpc: "2.0",
            id: 3,
            method: "initialize",
            params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "legacy-test", version: "0" } }
          },
          { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} },
          { jsonrpc: "2.0", id: 5, method: "resources/list", params: {} },
          { jsonrpc: "2.0", id: 6, method: "resources/templates/list", params: {} },
          { jsonrpc: "2.0", id: 7, method: "prompts/list", params: {} },
          { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "status", arguments: {} } },
          { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "get_current_message", arguments: {} } }
        ],
        stateDir
      );

      expect(responses).toHaveLength(9);
      const byId = responsesById(responses);

      const discover = resultObject(byId.get(1));
      expect(discover.supportedVersions).toEqual(["2026-07-28", "2025-06-18"]);
      expect(objectValue(discover.serverInfo).name).toBe("thunderbird-mcp");
      expect(objectValue(discover.capabilities).extensions).toEqual({});
      expect(discover.instructions).toContain("Thunderbird");

      const initialize = resultObject(byId.get(2));
      expect(initialize.protocolVersion).toBe("2026-07-28");
      expect(objectValue(initialize.capabilities).extensions).toEqual({});
      expect(objectValue(initialize.serverInfo).name).toBe("thunderbird-mcp");

      const legacyInitialize = resultObject(byId.get(3));
      expect(legacyInitialize.protocolVersion).toBe("2025-06-18");

      const toolsList = resultObject(byId.get(4));
      expectStaticCacheMetadata(toolsList);
      const tools = arrayValue(toolsList.tools) as Array<{ name: string }>;
      expect(tools.some((tool) => tool.name === "get_current_message")).toBe(true);
      expect(tools.some((tool) => tool.name === "save_attachment")).toBe(true);
      expect(tools.some((tool) => tool.name === "continue_search")).toBe(true);
      expect(tools.some((tool) => tool.name === "send_message")).toBe(true);
      expect(tools.some((tool) => tool.name === "delete_messages")).toBe(true);

      expectStaticCacheMetadata(resultObject(byId.get(5)));
      expectStaticCacheMetadata(resultObject(byId.get(6)));
      expectStaticCacheMetadata(resultObject(byId.get(7)));

      const status = resultObject(byId.get(8));
      expect(objectValue(status.structuredContent).connected).toBe(false);

      const currentMessage = resultObject(byId.get(9));
      expect(currentMessage.isError).toBe(true);
      expect(objectValue(currentMessage.structuredContent).code).toBe("BROKER_NOT_CONNECTED");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("returns Invalid Params for missing and invalid resource URIs", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "thunderbird-mcp-server-test-"));
    try {
      const responses = await runMcpRequests(
        [
          { jsonrpc: "2.0", id: 1, method: "resources/read", params: {} },
          { jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: "thunderbird-message://not-a-number" } },
          { jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri: "unsupported://message" } }
        ],
        stateDir
      );

      expect(responses).toHaveLength(3);
      const byId = responsesById(responses);
      expect(byId.get(1)?.error?.code).toBe(-32602);
      expect(byId.get(1)?.error?.message).toBe("resources/read params.uri must be a string");
      expect(byId.get(2)?.error?.code).toBe(-32602);
      expect(byId.get(2)?.error?.message).toContain("Invalid Thunderbird message resource URI");
      expect(objectValue(byId.get(2)?.error?.data).uri).toBe("thunderbird-message://not-a-number");
      expect(byId.get(3)?.error?.code).toBe(-32602);
      expect(byId.get(3)?.error?.message).toContain("Unsupported resource URI");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("adds private cache metadata to successful resource reads", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "thunderbird-mcp-server-test-"));
    const broker = createServer((socket) => handleFakeBrokerSocket(socket));
    try {
      await listen(broker);
      const address = broker.address();
      if (!address || typeof address === "string") {
        throw new Error("Fake broker did not listen on a TCP port");
      }

      await writeBrokerState(stateDir, address);
      const responses = await runMcpRequests(
        [{ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "thunderbird-message://123" } }],
        stateDir
      );

      expect(responses).toHaveLength(1);
      const resourceRead = resultObject(responses[0]);
      expect(resourceRead.ttlMs).toBe(30_000);
      expect(resourceRead.cacheScope).toBe("private");

      const contents = arrayValue(resourceRead.contents) as Array<{ uri: string; mimeType: string; text: string }>;
      expect(contents).toHaveLength(1);
      expect(contents[0].uri).toBe("thunderbird-message://123");
      expect(contents[0].mimeType).toBe("application/json");
      const payload = JSON.parse(contents[0].text) as Record<string, unknown>;
      expect(payload.type).toBe("tool.get_message");
      expect(payload.payload).toEqual({ messageId: 123, includeBody: true });
    } finally {
      await closeServer(broker);
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

async function runMcpRequests(requests: Array<Record<string, unknown>>, stateDir: string): Promise<JsonRpcResponse[]> {
  const child = spawn(process.execPath, [resolve("dist/host/src/cli.js"), "mcp"], {
    cwd: resolve("."),
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, THUNDERBIRD_MCP_STATE_DIR: stateDir }
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  child.stdin.end(`${requests.map((request) => JSON.stringify(request)).join("\n")}\n`);
  const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
  expect({ code, signal, stderr }).toEqual({ code: 0, signal: null, stderr: "" });

  return stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as JsonRpcResponse);
}

function responsesById(responses: JsonRpcResponse[]): Map<string | number | null | undefined, JsonRpcResponse> {
  return new Map(responses.map((response) => [response.id, response]));
}

function resultObject(response: JsonRpcResponse | undefined): Record<string, unknown> {
  expect(response).toBeDefined();
  expect(response?.error).toBeUndefined();
  expect(response?.result).toBeDefined();
  return response?.result as Record<string, unknown>;
}

function objectValue(value: unknown): Record<string, unknown> {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown): unknown[] {
  expect(Array.isArray(value)).toBe(true);
  return value as unknown[];
}

function expectStaticCacheMetadata(result: Record<string, unknown>): void {
  expect(result.ttlMs).toBe(3_600_000);
  expect(result.cacheScope).toBe("public");
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) {
        rejectClose(error);
        return;
      }
      resolveClose();
    });
  });
}

async function writeBrokerState(stateDir: string, address: AddressInfo): Promise<void> {
  await writeFile(
    join(stateDir, "broker.json"),
    `${JSON.stringify(
      {
        version: 1,
        host: "127.0.0.1",
        port: address.port,
        token: "test-token",
        pid: process.pid,
        nativeHostName: "com.thunderbird_mcp.bridge",
        extensionId: "thunderbird-mcp@local",
        startedAt: new Date().toISOString()
      },
      null,
      2
    )}\n`
  );
}

function handleFakeBrokerSocket(socket: Socket): void {
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }

      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) {
        continue;
      }

      const request = JSON.parse(line) as { id: string; type: string; payload?: unknown };
      socket.end(`${JSON.stringify({ id: request.id, ok: true, result: { type: request.type, payload: request.payload ?? null } })}\n`);
    }
  });
}
