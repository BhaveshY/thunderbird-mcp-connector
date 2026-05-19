import type { Socket } from "node:net";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { LineJsonSocket } from "../host/src/line-json.js";

describe("LineJsonSocket", () => {
  it("emits an error for malformed JSON lines", async () => {
    const socket = new PassThrough() as unknown as Socket;
    const lineSocket = new LineJsonSocket(socket);

    const errored = new Promise<Error>((resolve) => {
      lineSocket.once("error", resolve);
    });

    socket.write("{not json}\n");

    await expect(errored).resolves.toBeInstanceOf(Error);
  });
});
