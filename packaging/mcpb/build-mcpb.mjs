#!/usr/bin/env node
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const buildRoot = resolve(repoRoot, "build", "mcpb");
const packageRoot = resolve(buildRoot, "thunderbird-mcp");

await rm(packageRoot, { recursive: true, force: true });
await mkdir(packageRoot, { recursive: true });

await cp(resolve(repoRoot, "packaging", "mcpb", "manifest.json"), resolve(packageRoot, "manifest.json"));
await cp(resolve(repoRoot, "dist", "host"), resolve(packageRoot, "host"), { recursive: true });
await cp(resolve(repoRoot, "dist", "shared"), resolve(packageRoot, "shared"), { recursive: true });
await cp(resolve(repoRoot, "package.json"), resolve(packageRoot, "package.json"));

execFileSync("npx", ["mcpb", "pack", packageRoot, resolve(repoRoot, "build", "thunderbird-mcp-0.1.0.mcpb")], {
  cwd: repoRoot,
  stdio: "inherit"
});
