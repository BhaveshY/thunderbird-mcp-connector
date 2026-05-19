import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBrokerStatePath, readBrokerState } from "../host/src/state.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "thunderbird-mcp-state-test-"));
  process.env.THUNDERBIRD_MCP_STATE_DIR = tempDir;
});

afterEach(async () => {
  delete process.env.THUNDERBIRD_MCP_STATE_DIR;
  await rm(tempDir, { recursive: true, force: true });
});

describe("broker state", () => {
  it("treats corrupt state files as disconnected", async () => {
    await writeFile(getBrokerStatePath(), "{not json", "utf8");

    await expect(readBrokerState()).resolves.toBeNull();
  });

  it("rejects invalid broker ports", async () => {
    await writeFile(
      getBrokerStatePath(),
      JSON.stringify({
        version: 1,
        host: "127.0.0.1",
        port: 70000,
        token: "token",
        pid: 123,
        nativeHostName: "com.thunderbird_mcp.bridge",
        extensionId: "thunderbird-mcp@local",
        startedAt: new Date().toISOString()
      }),
      "utf8"
    );

    await expect(readBrokerState()).resolves.toBeNull();
  });
});
