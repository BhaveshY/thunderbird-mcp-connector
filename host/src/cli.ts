#!/usr/bin/env node
import { NativeProtocol } from "./native-protocol.js";
import { ThunderbirdBroker } from "./broker.js";
import { getClaudeAddJsonCommand, getClaudeCodeConfig } from "./claude-config.js";
import { installNativeHost, uninstallNativeHost } from "./install.js";
import { startMcpServer } from "./mcp-server.js";

async function main(): Promise<void> {
  const command = process.argv[2] ?? "help";

  switch (command) {
    case "native-host":
      await runNativeHost();
      return;
    case "mcp":
      startMcpServer();
      return;
    case "install-native":
      console.log(JSON.stringify(await installNativeHost(), null, 2));
      return;
    case "uninstall-native":
      console.log(JSON.stringify(await uninstallNativeHost(), null, 2));
      return;
    case "print-claude-config":
      console.log(JSON.stringify(getClaudeCodeConfig(), null, 2));
      console.error("\nClaude Code command:");
      console.error(getClaudeAddJsonCommand());
      return;
    case "help":
    default:
      printHelp();
  }
}

async function runNativeHost(): Promise<void> {
  const protocol = new NativeProtocol(process.stdin, process.stdout);
  const broker = new ThunderbirdBroker(protocol);

  const stop = async () => {
    await broker.stop();
    process.exit(0);
  };

  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  process.once("beforeExit", () => void broker.stop());

  const state = await broker.start();
  console.error(`[native-host] Broker listening on ${state.host}:${state.port}`);
  protocol.start();
}

function printHelp(): void {
  console.log(`Thunderbird MCP Connector

Usage:
  thunderbird-mcp native-host          Run as Thunderbird native messaging host
  thunderbird-mcp mcp                  Run stdio MCP server for Claude
  thunderbird-mcp install-native       Register native host for Thunderbird
  thunderbird-mcp uninstall-native     Remove native host registration
  thunderbird-mcp print-claude-config  Print Claude Code MCP configuration
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
