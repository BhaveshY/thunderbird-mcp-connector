import { describe, expect, it } from "vitest";
import { getClaudeCodeConfig } from "../host/src/claude-config.js";

describe("Claude Code config", () => {
  it("prints a stdio MCP server config", () => {
    const config = getClaudeCodeConfig() as {
      mcpServers: { thunderbird: { type: string; command: string; args: string[] } };
    };

    expect(config.mcpServers.thunderbird.type).toBe("stdio");
    expect(config.mcpServers.thunderbird.command).toBe(process.execPath);
    expect(config.mcpServers.thunderbird.args).toContain("mcp");
  });
});
