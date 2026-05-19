import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { JsonRpcLineServer } from "../host/src/mcp-jsonrpc.js";

describe("JsonRpcLineServer", () => {
  it("returns a null response id for requests with invalid id types", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const server = new JsonRpcLineServer(input, output);
    server.start();

    const response = new Promise<Record<string, unknown>>((resolve) => {
      output.once("data", (chunk) => {
        resolve(JSON.parse(Buffer.from(chunk).toString("utf8")));
      });
    });

    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: { nested: true }, method: "ping" })}\n`);

    await expect(response).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32600,
        message: "Invalid JSON-RPC request"
      }
    });
  });
});
