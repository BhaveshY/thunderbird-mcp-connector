#!/usr/bin/env node
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const buildRoot = resolve(repoRoot, "build", "mcpb");
const packageRoot = resolve(buildRoot, "thunderbird-mcp");
const manifest = JSON.parse(await readFile(resolve(repoRoot, "packaging", "mcpb", "manifest.json"), "utf8"));

await rm(packageRoot, { recursive: true, force: true });
await mkdir(packageRoot, { recursive: true });

await cp(resolve(repoRoot, "packaging", "mcpb", "manifest.json"), resolve(packageRoot, "manifest.json"));
await cp(resolve(repoRoot, "dist", "host"), resolve(packageRoot, "host"), { recursive: true });
await cp(resolve(repoRoot, "dist", "shared"), resolve(packageRoot, "shared"), { recursive: true });
await cp(resolve(repoRoot, "package.json"), resolve(packageRoot, "package.json"));

const mcpbCli = resolve(repoRoot, "node_modules", "@anthropic-ai", "mcpb", "dist", "cli", "cli.js");
const output = resolve(repoRoot, "build", `thunderbird-mcp-${manifest.version}.mcpb`);

execFileSync(process.execPath, [mcpbCli, "pack", packageRoot, output], {
  cwd: repoRoot,
  stdio: "inherit"
});
