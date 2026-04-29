import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import type { JsonObject, JsonValue } from "../../shared/src/types.js";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: JsonValue;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export class JsonRpcLineServer extends EventEmitter<{
  request: [JsonRpcRequest];
  error: [Error];
}> {
  private buffer = "";

  constructor(
    private readonly input: Readable,
    private readonly output: Writable
  ) {
    super();
  }

  start(): void {
    this.input.setEncoding("utf8");
    this.input.on("data", (chunk: string) => this.receive(chunk));
    this.input.on("error", (error) => this.emit("error", error));
  }

  sendResult(id: string | number | null, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  sendError(id: string | number | null, code: number, message: string, data?: unknown): void {
    const response: JsonRpcFailure = { jsonrpc: "2.0", id, error: { code, message } };
    if (data !== undefined) {
      response.error.data = data;
    }
    this.write(response);
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const index = this.buffer.indexOf("\n");
      if (index === -1) {
        return;
      }

      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) {
        continue;
      }

      try {
        const request = JSON.parse(line) as JsonRpcRequest;
        if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
          this.sendError(request.id ?? null, -32600, "Invalid JSON-RPC request");
          continue;
        }
        this.emit("request", request);
      } catch (error) {
        this.sendError(null, -32700, "Parse error", {
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  private write(message: JsonRpcSuccess | JsonRpcFailure | JsonObject): void {
    this.output.write(`${JSON.stringify(message)}\n`);
  }
}
