import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { MAX_NATIVE_MESSAGE_BYTES } from "../../shared/src/constants.js";
import type { JsonValue } from "../../shared/src/types.js";

export interface NativeProtocolEvents {
  message: [JsonValue];
  error: [Error];
  close: [];
}

export class NativeProtocol extends EventEmitter<NativeProtocolEvents> {
  private buffer = Buffer.alloc(0);
  private closed = false;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable
  ) {
    super();
  }

  start(): void {
    this.input.on("data", (chunk: Buffer | string) => this.receive(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    this.input.on("error", (error) => this.emit("error", error));
    this.input.on("end", () => this.emitClose());
    this.input.on("close", () => this.emitClose());
  }

  send(message: unknown): void {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    if (body.length > MAX_NATIVE_MESSAGE_BYTES) {
      throw new Error(`Native message exceeds ${MAX_NATIVE_MESSAGE_BYTES} bytes`);
    }
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    this.output.write(Buffer.concat([header, body]));
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > MAX_NATIVE_MESSAGE_BYTES) {
        this.buffer = Buffer.alloc(0);
        this.emit("error", new Error(`Native message length ${length} exceeds ${MAX_NATIVE_MESSAGE_BYTES} bytes`));
        return;
      }
      if (this.buffer.length < 4 + length) {
        return;
      }

      const body = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);

      try {
        this.emit("message", JSON.parse(body.toString("utf8")) as JsonValue);
      } catch (error) {
        this.emit("error", error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private emitClose(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.emit("close");
  }
}
