import { resolve } from "node:path";
import { dirname } from "node:path";
import { platform } from "node:os";
import { fileURLToPath } from "node:url";
import { MCP_SERVER_NAME } from "../../shared/src/constants.js";

export function getClaudeCodeConfig(): object {
  const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");
  return {
    mcpServers: {
      thunderbird: {
        type: "stdio",
        command: process.execPath,
        args: [cliPath, "mcp"],
        env: {}
      }
    }
  };
}

export function getClaudeAddJsonCommand(): string {
  const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");
  const json = JSON.stringify({
    type: "stdio",
    command: process.execPath,
    args: [cliPath, "mcp"],
    env: {}
  });
  return `claude mcp add-json ${MCP_SERVER_NAME} ${quoteForCurrentShell(json)} --scope user`;
}

export function quoteForCurrentShell(value: string, currentPlatform = platform()): string {
  if (currentPlatform === "win32") {
    return `'${value.replaceAll("'", "''")}'`;
  }

  return `'${value.replaceAll("'", "'\\''")}'`;
}
