import { connect } from "node:net";
import { DEFAULT_NATIVE_TIMEOUT_MS } from "../../shared/src/constants.js";
import type { BrokerRequest, BrokerResponse, JsonValue } from "../../shared/src/types.js";
import { ConnectorError } from "./errors.js";
import { LineJsonSocket } from "./line-json.js";
import { readBrokerState } from "./state.js";

export async function callBroker(type: string, payload?: JsonValue, timeoutMs = DEFAULT_NATIVE_TIMEOUT_MS): Promise<JsonValue> {
  const state = await readBrokerState();
  if (!state) {
    throw new ConnectorError(
      "Thunderbird bridge is not connected. Open Thunderbird and make sure the Thunderbird MCP add-on is enabled.",
      "BROKER_NOT_CONNECTED"
    );
  }

  return new Promise<JsonValue>((resolve, reject) => {
    const socket = connect({ host: state.host, port: state.port });
    const id = crypto.randomUUID();
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      socket.destroy();
      reject(error);
    };
    const succeed = (value: JsonValue) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve(value);
    };
    timer = setTimeout(() => {
      fail(new ConnectorError(`Timed out waiting for broker response to ${type}`, "BROKER_TIMEOUT"));
    }, timeoutMs);

    socket.once("close", () => {
      fail(new ConnectorError(`Broker connection closed before responding to ${type}`, "BROKER_CLOSED"));
    });

    socket.once("connect", () => {
      const lineSocket = new LineJsonSocket(socket);
      lineSocket.once("message", (raw) => {
        const response = raw as BrokerResponse;
        if (response.ok) {
          succeed(response.result ?? null);
        } else {
          fail(
            new ConnectorError(
              response.error?.message ?? "Broker request failed",
              response.error?.code ?? "BROKER_REQUEST_FAILED",
              response.error?.details
            )
          );
        }
        lineSocket.end();
      });
      lineSocket.once("error", (error) => {
        fail(error);
      });
      lineSocket.send({ id, token: state.token, type, payload } satisfies BrokerRequest);
    });

    socket.once("error", (error) => {
      if (isConnectionResetError(error)) {
        fail(
          new ConnectorError(`Broker connection closed before responding to ${type}`, "BROKER_CLOSED", {
            cause: error.message
          })
        );
        return;
      }

      fail(
        new ConnectorError(
          "Could not connect to Thunderbird bridge. Restart Thunderbird or reinstall the native host.",
          "BROKER_CONNECT_FAILED",
          { cause: error.message }
        )
      );
    });
  });
}

export async function getBrokerStatus(): Promise<JsonValue> {
  return callBroker("broker.status", undefined, 5_000);
}

function isConnectionResetError(error: Error): boolean {
  return (error as { code?: unknown }).code === "ECONNRESET";
}
