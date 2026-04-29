import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import {
  BROKER_STATE_FILE,
  EXTENSION_ID,
  NATIVE_HOST_NAME,
  STATE_DIR_NAME
} from "../../shared/src/constants.js";
import type { BrokerState } from "../../shared/src/types.js";

export function getStateDir(): string {
  if (process.env.THUNDERBIRD_MCP_STATE_DIR) {
    return process.env.THUNDERBIRD_MCP_STATE_DIR;
  }
  return join(homedir(), STATE_DIR_NAME);
}

export function getBrokerStatePath(): string {
  return join(getStateDir(), BROKER_STATE_FILE);
}

export async function ensureStateDir(): Promise<string> {
  const dir = getStateDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function createBrokerState(port: number): BrokerState {
  return {
    version: 1,
    host: "127.0.0.1",
    port,
    token: randomBytes(32).toString("hex"),
    pid: process.pid,
    nativeHostName: NATIVE_HOST_NAME,
    extensionId: EXTENSION_ID,
    startedAt: new Date().toISOString()
  };
}

export async function writeBrokerState(state: BrokerState): Promise<void> {
  await ensureStateDir();
  await writeFile(getBrokerStatePath(), `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600
  });
}

export async function readBrokerState(): Promise<BrokerState | null> {
  const path = getBrokerStatePath();
  if (!existsSync(path)) {
    return null;
  }

  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as BrokerState;
  if (
    parsed.version !== 1 ||
    parsed.host !== "127.0.0.1" ||
    typeof parsed.port !== "number" ||
    typeof parsed.token !== "string"
  ) {
    return null;
  }
  return parsed;
}

export async function removeBrokerState(): Promise<void> {
  await rm(getBrokerStatePath(), { force: true });
}

export function getNativeManifestPath(): string {
  if (process.env.THUNDERBIRD_MCP_NATIVE_MANIFEST_PATH) {
    return process.env.THUNDERBIRD_MCP_NATIVE_MANIFEST_PATH;
  }
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Mozilla", "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`);
  }
  if (platform() === "win32") {
    const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "ThunderbirdMCP", `${NATIVE_HOST_NAME}.json`);
  }
  return join(homedir(), ".mozilla", "native-messaging-hosts", `${NATIVE_HOST_NAME}.json`);
}

export function getNativeWrapperPath(): string {
  const ext = platform() === "win32" ? ".cmd" : "";
  return join(getStateDir(), `thunderbird-mcp-native-host${ext}`);
}
