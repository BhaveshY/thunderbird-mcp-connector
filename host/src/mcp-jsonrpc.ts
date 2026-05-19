import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { MAX_LINE_JSON_BYTES } from "../../shared/src/constants.js";
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

export function isJsonRpcNotification(request: JsonRpcRequest): boolean {
  return !Object.prototype.hasOwnProperty.call(request, "id");
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
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_LINE_JSON_BYTES) {
      const error = new Error(`JSON-RPC line exceeds ${MAX_LINE_JSON_BYTES} bytes`);
      this.buffer = "";
      this.sendError(null, -32700, "Parse error", { message: error.message });
      this.emit("error", error);
      return;
    }

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
        const parsed = JSON.parse(line) as unknown;
        if (!isJsonObject(parsed)) {
          this.sendError(null, -32600, "Invalid JSON-RPC request");
          continue;
        }

        const request = parsed as unknown as JsonRpcRequest;
        const responseId = responseIdFor(parsed);
        if (request.jsonrpc !== "2.0" || typeof request.method !== "string" || !hasValidId(parsed)) {
          this.sendError(responseId, -32600, "Invalid JSON-RPC request");
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

function isJsonObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasValidId(value: JsonObject): boolean {
  if (!Object.prototype.hasOwnProperty.call(value, "id")) {
    return true;
  }

  return value.id === null || typeof value.id === "string" || typeof value.id === "number";
}

function responseIdFor(value: JsonObject): string | number | null {
  return value.id === null || typeof value.id === "string" || typeof value.id === "number" ? value.id : null;
}
