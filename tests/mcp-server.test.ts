import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("MCP server", () => {
  it("responds to initialize, tools/list, and disconnected status", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "thunderbird-mcp-server-test-"));
    const child = spawn(process.execPath, [resolve("dist/host/src/cli.js"), "mcp"], {
      cwd: resolve("."),
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, THUNDERBIRD_MCP_STATE_DIR: stateDir }
    });

    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "ping", params: {} })}\n`);
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } }
      })}\n`
    );
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "status", arguments: {} }
      })}\n`
    );
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "get_current_message", arguments: {} }
      })}\n`
    );
    child.stdin.end();

    await once(child, "exit");

    const responses = stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(responses).toHaveLength(4);
    const byId = new Map(responses.map((response) => [response.id, response]));
    expect(byId.get(1).result.serverInfo.name).toBe("thunderbird-mcp");
    expect(byId.get(2).result.tools.some((tool: { name: string }) => tool.name === "get_current_message")).toBe(true);
    expect(byId.get(2).result.tools.some((tool: { name: string }) => tool.name === "save_attachment")).toBe(true);
    expect(byId.get(3).result.structuredContent.connected).toBe(false);
    expect(byId.get(4).result.isError).toBe(true);
    expect(byId.get(4).result.structuredContent.code).toBe("BROKER_NOT_CONNECTED");
    await rm(stateDir, { recursive: true, force: true });
  });
});
