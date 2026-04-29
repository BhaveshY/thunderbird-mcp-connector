import { createServer, type Server, type Socket } from "node:net";
import { DEFAULT_NATIVE_TIMEOUT_MS } from "../../shared/src/constants.js";
import type {
  BrokerRequest,
  BrokerResponse,
  BrokerState,
  JsonObject,
  JsonValue,
  NativeBridgeResponse
} from "../../shared/src/types.js";
import { ConnectorError, serializeError } from "./errors.js";
import { LineJsonSocket } from "./line-json.js";
import { NativeProtocol } from "./native-protocol.js";
import { createBrokerState, removeBrokerState, writeBrokerState } from "./state.js";

interface PendingNativeRequest {
  resolve: (value: JsonValue) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export class ThunderbirdBroker {
  private server: Server | null = null;
  private state: BrokerState | null = null;
  private readonly pending = new Map<string, PendingNativeRequest>();

  constructor(private readonly nativeProtocol: NativeProtocol) {}

  async start(): Promise<BrokerState> {
    this.nativeProtocol.on("message", (message) => this.handleNativeMessage(message));
    this.nativeProtocol.on("close", () => void this.stop());
    this.nativeProtocol.on("error", (error) => {
      console.error(`[native-host] Native messaging error: ${error.message}`);
    });

    this.server = createServer((socket) => this.handleBrokerClient(socket));

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(0, "127.0.0.1", () => resolve());
    });

    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new ConnectorError("Could not determine broker port", "BROKER_START_FAILED");
    }

    this.state = createBrokerState(address.port);
    await writeBrokerState(this.state);
    return this.state;
  }

  async stop(): Promise<void> {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ConnectorError("Native host stopped", "NATIVE_HOST_STOPPED"));
    }
    this.pending.clear();

    await new Promise<void>((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
    this.server = null;
    await removeBrokerState();
  }

  private handleBrokerClient(socket: Socket): void {
    socket.setNoDelay(true);
    const peer = new LineJsonSocket(socket);

    peer.on("message", (message) => {
      void this.handleBrokerMessage(peer, message);
    });
    peer.on("error", (error) => {
      peer.send(this.errorResponse("invalid", error));
      peer.end();
    });
  }

  private async handleBrokerMessage(peer: LineJsonSocket, raw: unknown): Promise<void> {
    const request = raw as Partial<BrokerRequest>;
    const id = typeof request.id === "string" ? request.id : "invalid";

    try {
      if (!this.state) {
        throw new ConnectorError("Broker is not ready", "BROKER_NOT_READY");
      }
      if (request.token !== this.state.token) {
        throw new ConnectorError("Invalid broker token", "UNAUTHORIZED");
      }
      if (typeof request.type !== "string") {
        throw new ConnectorError("Broker request type is required", "INVALID_REQUEST");
      }

      let result: JsonValue;
      if (request.type === "broker.status") {
        result = {
          connected: true,
          pid: process.pid,
          startedAt: this.state.startedAt,
          nativeHostName: this.state.nativeHostName,
          extensionId: this.state.extensionId
        };
      } else {
        result = await this.forwardToThunderbird(request.type, request.payload);
      }

      peer.send({ id, ok: true, result } satisfies BrokerResponse);
    } catch (error) {
      peer.send(this.errorResponse(id, error));
    }
  }

  private forwardToThunderbird(type: string, payload?: JsonValue): Promise<JsonValue> {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ConnectorError(`Timed out waiting for Thunderbird response to ${type}`, "NATIVE_TIMEOUT"));
      }, DEFAULT_NATIVE_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
      this.nativeProtocol.send(payload === undefined ? { id, type } : { id, type, payload });
    });
  }

  private handleNativeMessage(message: JsonValue): void {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      console.error("[native-host] Ignoring non-object message from Thunderbird");
      return;
    }

    const response = message as unknown as NativeBridgeResponse;
    if (typeof response.id !== "string") {
      console.error("[native-host] Ignoring native message without id");
      return;
    }

    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(response.id);

    if (response.ok) {
      pending.resolve(response.result ?? null);
    } else {
      pending.reject(
        new ConnectorError(
          response.error?.message ?? "Thunderbird request failed",
          response.error?.code ?? "NATIVE_REQUEST_FAILED",
          response.error?.details
        )
      );
    }
  }

  private errorResponse(id: string, error: unknown): BrokerResponse {
    const serialized = serializeError(error);
    return {
      id,
      ok: false,
      error: {
        message: serialized.message,
        code: serialized.code,
        details: serialized.details as JsonValue | undefined
      }
    };
  }
}
