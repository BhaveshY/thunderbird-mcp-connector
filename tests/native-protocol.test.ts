import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { NativeProtocol } from "../host/src/native-protocol.js";

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
});
