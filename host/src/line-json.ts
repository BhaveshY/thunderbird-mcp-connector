import { EventEmitter } from "node:events";
import type { Socket } from "node:net";

export class LineJsonSocket extends EventEmitter<{
  message: [unknown];
  error: [Error];
  close: [];
}> {
  private buffer = "";

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
        this.emit("message", JSON.parse(line));
      } catch (error) {
        this.emit("error", error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
}
