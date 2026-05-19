import { createServer, type AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callBroker } from "../host/src/broker-client.js";
import { ThunderbirdBroker } from "../host/src/broker.js";
import { NativeProtocol } from "../host/src/native-protocol.js";
import { writeBrokerState } from "../host/src/state.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "thunderbird-mcp-test-"));
  process.env.THUNDERBIRD_MCP_STATE_DIR = tempDir;
});

afterEach(async () => {
  delete process.env.THUNDERBIRD_MCP_STATE_DIR;
  await rm(tempDir, { recursive: true, force: true });
});

describe("ThunderbirdBroker", () => {
  it("forwards broker requests to the native messaging protocol", async () => {
    const hostInput = new PassThrough();
    const hostOutput = new PassThrough();
    const protocol = new NativeProtocol(hostInput, hostOutput);
    const broker = new ThunderbirdBroker(protocol);

    protocol.start();
    await broker.start();

    const outgoingNativeMessage = readOneNativeMessage(hostOutput);
    const brokerCall = callBroker("tool.get_current_message", { includeBody: false });

    const nativeRequest = (await outgoingNativeMessage) as { id: string; type: string; payload: unknown };
    expect(nativeRequest.type).toBe("tool.get_current_message");
    expect(nativeRequest.payload).toEqual({ includeBody: false });

    writeNativeMessage(hostInput, {
      id: nativeRequest.id,
      ok: true,
      result: { id: 42, subject: "Bridge works" }
    });

    await expect(brokerCall).resolves.toEqual({ id: 42, subject: "Bridge works" });
    await broker.stop();
  });

  it("fails promptly when the broker closes before sending a response", async () => {
    const server = createServer((socket) => {
      socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    await writeBrokerState({
      version: 1,
      host: "127.0.0.1",
      port: address.port,
      token: "token",
      pid: process.pid,
      nativeHostName: "com.thunderbird_mcp.bridge",
      extensionId: "thunderbird-mcp@local",
      startedAt: new Date().toISOString()
    });

    await expect(callBroker("tool.get_current_message", {}, 10_000)).rejects.toMatchObject({
      code: "BROKER_CLOSED"
    });

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

async function readOneNativeMessage(stream: PassThrough): Promise<unknown> {
  const chunks: Buffer[] = [];
  return new Promise((resolve) => {
    stream.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
      const buffer = Buffer.concat(chunks);
      if (buffer.length < 4) {
        return;
      }
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) {
        return;
      }
      resolve(JSON.parse(buffer.subarray(4, 4 + length).toString("utf8")));
    });
  });
}

function writeNativeMessage(stream: PassThrough, message: unknown): void {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  stream.write(Buffer.concat([header, body]));
}
