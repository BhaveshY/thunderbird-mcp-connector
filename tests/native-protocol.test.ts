import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { NativeProtocol } from "../host/src/native-protocol.js";
import { MAX_NATIVE_MESSAGE_BYTES } from "../shared/src/constants.js";

describe("NativeProtocol", () => {
  it("writes Mozilla native messaging length-prefixed JSON", () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const protocol = new NativeProtocol(input, output);

    const chunks: Buffer[] = [];
    output.on("data", (chunk) => chunks.push(Buffer.from(chunk)));

    protocol.send({ ok: true, message: "hello" });

    const frame = Buffer.concat(chunks);
    const length = frame.readUInt32LE(0);
    const body = JSON.parse(frame.subarray(4, 4 + length).toString("utf8"));

    expect(body).toEqual({ ok: true, message: "hello" });
  });

  it("reads Mozilla native messaging length-prefixed JSON", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const protocol = new NativeProtocol(input, output);
    protocol.start();

    const received = new Promise((resolve) => {
      protocol.once("message", resolve);
    });

    const body = Buffer.from(JSON.stringify({ id: "1", type: "ping" }), "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    input.write(Buffer.concat([header, body]));

    await expect(received).resolves.toEqual({ id: "1", type: "ping" });
  });

  it("rejects oversized incoming frames before buffering the body", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const protocol = new NativeProtocol(input, output);
    protocol.start();

    const errored = new Promise<Error>((resolve) => {
      protocol.once("error", resolve);
    });

    const header = Buffer.alloc(4);
    header.writeUInt32LE(MAX_NATIVE_MESSAGE_BYTES + 1, 0);
    input.write(header);

    await expect(errored).resolves.toMatchObject({
      message: `Native message length ${MAX_NATIVE_MESSAGE_BYTES + 1} exceeds ${MAX_NATIVE_MESSAGE_BYTES} bytes`
    });
  });

  it("emits close once when the input ends and closes", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const protocol = new NativeProtocol(input, output);
    let closeCount = 0;
    protocol.on("close", () => {
      closeCount += 1;
    });
    protocol.start();

    input.end();
    await new Promise((resolve) => setImmediate(resolve));

    expect(closeCount).toBe(1);
  });
});
