import { execFileSync } from "node:child_process";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { platform } from "node:os";
import { fileURLToPath } from "node:url";
import { EXTENSION_ID, NATIVE_HOST_NAME } from "../../shared/src/constants.js";
import { ensureStateDir, getNativeManifestPath, getNativeWrapperPath } from "./state.js";

export interface InstallResult {
  manifestPath: string;
  wrapperPath: string;
  nativeHostName: string;
  extensionId: string;
}

export async function installNativeHost(): Promise<InstallResult> {
  await ensureStateDir();

  const wrapperPath = getNativeWrapperPath();
  const manifestPath = getNativeManifestPath();
  const cliPath = getCliPath();

  await mkdir(dirname(wrapperPath), { recursive: true, mode: 0o700 });
  await mkdir(dirname(manifestPath), { recursive: true, mode: 0o700 });

  if (platform() === "win32") {
    await writeWindowsWrapper(wrapperPath, cliPath);
  } else {
    await writePosixWrapper(wrapperPath, cliPath);
  }

  const manifest = {
    name: NATIVE_HOST_NAME,
    description: "Thunderbird MCP native bridge",
    path: wrapperPath,
    type: "stdio",
    allowed_extensions: [EXTENSION_ID]
  };

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

  if (platform() === "win32") {
    addWindowsNativeHostRegistry(manifestPath);
  }

  return { manifestPath, wrapperPath, nativeHostName: NATIVE_HOST_NAME, extensionId: EXTENSION_ID };
}

export async function uninstallNativeHost(): Promise<InstallResult> {
  const wrapperPath = getNativeWrapperPath();
  const manifestPath = getNativeManifestPath();

  await rm(manifestPath, { force: true });
  await rm(wrapperPath, { force: true });

  if (platform() === "win32") {
    deleteWindowsNativeHostRegistry();
  }

  return { manifestPath, wrapperPath, nativeHostName: NATIVE_HOST_NAME, extensionId: EXTENSION_ID };
}

function getCliPath(): string {
  const currentFile = fileURLToPath(import.meta.url);
  return resolve(dirname(currentFile), "cli.js");
}

async function writePosixWrapper(wrapperPath: string, cliPath: string): Promise<void> {
  const nodePath = process.execPath;
  const script = `#!/bin/sh
exec "${nodePath}" "${cliPath}" native-host
`;
  await writeFile(wrapperPath, script, { mode: 0o700 });
  await chmod(wrapperPath, 0o700);
}

async function writeWindowsWrapper(wrapperPath: string, cliPath: string): Promise<void> {
  const nodePath = process.execPath;
  const script = `@echo off\r\n"${nodePath}" "${cliPath}" native-host\r\n`;
  await writeFile(wrapperPath, script, { mode: 0o700 });
}

function addWindowsNativeHostRegistry(manifestPath: string): void {
  for (const key of getWindowsRegistryKeys()) {
    execFileSync("reg", ["add", key, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"]);
  }
}

function deleteWindowsNativeHostRegistry(): void {
  for (const key of getWindowsRegistryKeys()) {
    try {
      execFileSync("reg", ["delete", key, "/f"]);
    } catch {
      // Already absent.
    }
  }
}

function getWindowsRegistryKeys(): string[] {
  return [
    `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
    `HKCU\\Software\\Wow6432Node\\Mozilla\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`
  ];
}
