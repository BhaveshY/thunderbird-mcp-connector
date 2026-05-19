import { describe, expect, it } from "vitest";
import { getClaudeCodeConfig, quoteForCurrentShell } from "../host/src/claude-config.js";

describe("Claude Code config", () => {
  it("prints a stdio MCP server config", () => {
    const config = getClaudeCodeConfig() as {
      mcpServers: { thunderbird: { type: string; command: string; args: string[] } };
    };

    expect(config.mcpServers.thunderbird.type).toBe("stdio");
    expect(config.mcpServers.thunderbird.command).toBe(process.execPath);
    expect(config.mcpServers.thunderbird.args).toContain("mcp");
  });

  it("uses shell quoting that matches the target platform", () => {
    expect(quoteForCurrentShell("C:\\Users\\O'Brien\\cli.js", "win32")).toBe("'C:\\Users\\O''Brien\\cli.js'");
    expect(quoteForCurrentShell("a'b", "linux")).toBe("'a'\\''b'");
  });
});
