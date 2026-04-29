import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callBroker } from "../host/src/broker-client.js";
import { ThunderbirdBroker } from "../host/src/broker.js";
import { NativeProtocol } from "../host/src/native-protocol.js";

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
