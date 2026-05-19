import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { MAX_LINE_JSON_BYTES } from "../../shared/src/constants.js";

export class LineJsonSocket extends EventEmitter<{
  message: [unknown];
  error: [Error];
  close: [];
}> {
  private buffer = "";
  private failed = false;

  constructor(private readonly socket: Socket) {
    super();
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.receive(chunk));
    socket.on("error", (error) => this.emit("error", error));
    socket.on("close", () => this.emit("close"));
  }

  send(message: unknown): void {
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

  end(): void {
    this.socket.end();
  }

  private receive(chunk: string): void {
    if (this.failed) {
      return;
    }
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_LINE_JSON_BYTES) {
      this.fail(new Error(`Line-delimited JSON message exceeds ${MAX_LINE_JSON_BYTES} bytes`));
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
        this.emit("message", JSON.parse(line));
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
  }

  private fail(error: Error): void {
    if (this.failed) {
      return;
    }
    this.failed = true;
    this.emit("error", error);
    this.end();
  }
}
