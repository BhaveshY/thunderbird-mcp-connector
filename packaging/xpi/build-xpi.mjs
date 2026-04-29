#!/usr/bin/env node
import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const buildDir = resolve(repoRoot, "build");
const output = resolve(buildDir, "thunderbird-mcp-bridge-0.1.0.xpi");

await mkdir(buildDir, { recursive: true });
await rm(output, { force: true });

execFileSync("zip", ["-r", output, "manifest.json", "src", "icons"], {
  cwd: resolve(repoRoot, "addon"),
  stdio: "inherit"
});

console.log(output);
