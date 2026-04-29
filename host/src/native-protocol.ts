import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import type { JsonValue } from "../../shared/src/types.js";

export interface NativeProtocolEvents {
  message: [JsonValue];
  error: [Error];
  close: [];
}

export class NativeProtocol extends EventEmitter<NativeProtocolEvents> {
  private buffer = Buffer.alloc(0);

  constructor(
    private readonly input: Readable,
    private readonly output: Writable
  ) {
    super();
  }

  start(): void {
    this.input.on("data", (chunk: Buffer) => this.receive(chunk));
    this.input.on("error", (error) => this.emit("error", error));
    this.input.on("end", () => this.emit("close"));
    this.input.on("close", () => this.emit("close"));
  }

  send(message: unknown): void {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    this.output.write(Buffer.concat([header, body]));
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
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
}
