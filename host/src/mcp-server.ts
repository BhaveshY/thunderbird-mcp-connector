import {
  CONNECTOR_VERSION,
  MCP_SERVER_NAME,
  MCP_SERVER_TITLE,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS
} from "../../shared/src/constants.js";
import type { JsonObject, JsonValue } from "../../shared/src/types.js";
import { callBroker } from "./broker-client.js";
import { serializeError } from "./errors.js";
import { isJsonRpcNotification, JsonRpcLineServer, type JsonRpcRequest } from "./mcp-jsonrpc.js";
import { callTool, tools } from "./mcp-tools.js";

const STATIC_CACHE_METADATA = {
  ttlMs: 60 * 60 * 1000,
  cacheScope: "public"
} as const;

const PRIVATE_RESOURCE_CACHE_METADATA = {
  ttlMs: 30 * 1000,
  cacheScope: "private"
} as const;

const UNCACHEABLE_PRIVATE_METADATA = {
  ttlMs: 0,
  cacheScope: "private"
} as const;

const SERVER_CAPABILITIES: JsonObject = {
  tools: { listChanged: false },
  resources: { listChanged: false, subscribe: false },
  prompts: { listChanged: false },
  extensions: {}
};

const SERVER_INFO: JsonObject = {
  name: MCP_SERVER_NAME,
  title: MCP_SERVER_TITLE,
  version: CONNECTOR_VERSION
};

const SERVER_INSTRUCTIONS =
  "This local connector accesses Thunderbird only through the installed Thunderbird add-on. Use compact paged search tools for old mailboxes, then get_message/save_attachment for details. It can draft, send with explicit confirmSend=true, and organize messages with Thunderbird permissions.";

class JsonRpcResponseError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: JsonValue
  ) {
    super(message);
    this.name = "JsonRpcResponseError";
  }
}

export function startMcpServer(): void {
  const server = new JsonRpcLineServer(process.stdin, process.stdout);

  server.on("request", (request) => {
    void handleRequest(server, request);
  });
  server.on("error", (error) => {
    console.error(`[mcp] ${error.message}`);
  });
  server.start();
}

async function handleRequest(server: JsonRpcLineServer, request: JsonRpcRequest): Promise<void> {
  if (isJsonRpcNotification(request)) {
    return;
  }

  const id = request.id ?? null;

  try {
    switch (request.method) {
      case "server/discover":
        server.sendResult(id, discoverResult());
        return;
      case "initialize":
        server.sendResult(id, initializeResult(request.params));
        return;
      case "notifications/initialized":
        return;
      case "ping":
        server.sendResult(id, {});
        return;
      case "tools/list":
        server.sendResult(id, { tools, ...STATIC_CACHE_METADATA });
        return;
      case "tools/call":
        server.sendResult(id, await handleToolCall(request.params));
        return;
      case "resources/list":
        server.sendResult(id, { resources: [], ...STATIC_CACHE_METADATA });
        return;
      case "resources/templates/list":
        server.sendResult(id, {
          resourceTemplates: [
            {
              uriTemplate: "thunderbird-message://{messageId}",
              name: "message",
              title: "Thunderbird Message",
              description: "Read a Thunderbird message by current internal message id.",
              mimeType: "application/json"
            },
            {
              uriTemplate: "thunderbird-current://message",
              name: "current_message",
              title: "Current Thunderbird Message",
              description: "Read the message currently displayed in Thunderbird.",
              mimeType: "application/json"
            },
            {
              uriTemplate: "thunderbird-headers://{messageId}",
              name: "message_headers",
              title: "Thunderbird Message Headers",
              description: "Read decoded RFC 822 headers for a Thunderbird message.",
              mimeType: "application/json"
            },
            {
              uriTemplate: "thunderbird-attachment://{messageId}/{partName}",
              name: "attachment",
              title: "Thunderbird Attachment",
              description: "Read attachment metadata and text/base64 content by message id and MIME part name.",
              mimeType: "application/json"
            }
          ],
          ...STATIC_CACHE_METADATA
        });
        return;
      case "resources/read":
        server.sendResult(id, await handleResourceRead(request.params));
        return;
      case "prompts/list":
        server.sendResult(id, {
          prompts: [
            {
              name: "draft_reply",
              title: "Draft Reply",
              description: "Draft a reply to the currently displayed Thunderbird message.",
              arguments: [{ name: "tone", description: "Optional tone or style guidance.", required: false }]
            },
            {
              name: "triage_current_message",
              title: "Triage Current Message",
              description: "Summarize the current email, extract actions, and suggest a reply.",
              arguments: []
            }
          ],
          ...STATIC_CACHE_METADATA
        });
        return;
      case "prompts/get":
        server.sendResult(id, handlePromptGet(request.params));
        return;
      default:
        server.sendError(id, -32601, `Method not found: ${request.method}`);
    }
  } catch (error) {
    if (error instanceof JsonRpcResponseError) {
      server.sendError(id, error.code, error.message, error.data);
      return;
    }

    const serialized = serializeError(error);
    server.sendError(id, -32000, serialized.message, {
      code: serialized.code ?? "SERVER_ERROR",
      details: serialized.details as JsonValue | undefined
    });
  }
}

function discoverResult(): JsonObject {
  return {
    supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
    capabilities: SERVER_CAPABILITIES,
    serverInfo: SERVER_INFO,
    instructions: SERVER_INSTRUCTIONS
  };
}

function initializeResult(params: JsonValue | undefined): JsonObject {
  const requestedVersion =
    params && typeof params === "object" && !Array.isArray(params)
      ? (params as JsonObject).protocolVersion
      : undefined;

  return {
    protocolVersion: chooseProtocolVersion(requestedVersion),
    capabilities: SERVER_CAPABILITIES,
    serverInfo: SERVER_INFO,
    instructions: SERVER_INSTRUCTIONS
  };
}

function chooseProtocolVersion(requestedVersion: JsonValue | undefined): string {
  if (typeof requestedVersion === "string" && SUPPORTED_PROTOCOL_VERSIONS.some((version) => version === requestedVersion)) {
    return requestedVersion;
  }
  return PROTOCOL_VERSION;
}

async function handleToolCall(params: JsonValue | undefined): Promise<JsonObject> {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("tools/call params must be an object");
  }

  const object = params as JsonObject;
  const name = object.name;
  if (typeof name !== "string") {
    throw new Error("tools/call params.name must be a string");
  }

  try {
    const result = await callTool(name, object.arguments);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2)
        }
      ],
      structuredContent: result,
      isError: false
    };
  } catch (error) {
    const serialized = serializeError(error);
    const result: JsonObject = {
      error: serialized.message,
      code: serialized.code ?? "TOOL_ERROR"
    };
    if (serialized.details !== undefined) {
      result.details = serialized.details as JsonValue;
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2)
        }
      ],
      structuredContent: result,
      isError: true
    };
  }
}

async function handleResourceRead(params: JsonValue | undefined): Promise<JsonObject> {
  if (!params || typeof params !== "object" || Array.isArray(params) || typeof (params as JsonObject).uri !== "string") {
    throw invalidParams("resources/read params.uri must be a string");
  }

  const uri = (params as JsonObject).uri as string;
  let result: JsonValue;
  let cacheMetadata = PRIVATE_RESOURCE_CACHE_METADATA;

  if (uri === "thunderbird-current://message") {
    result = await callBroker("tool.get_current_message", { includeBody: true });
    cacheMetadata = UNCACHEABLE_PRIVATE_METADATA;
  } else if (uri.startsWith("thunderbird-message://")) {
    const rawId = uri.slice("thunderbird-message://".length);
    const messageId = Number(rawId);
    if (!rawId || !Number.isInteger(messageId)) {
      throw invalidResourceUri("Invalid Thunderbird message resource URI", uri);
    }
    result = await callBroker("tool.get_message", { messageId, includeBody: true });
  } else if (uri.startsWith("thunderbird-headers://")) {
    const rawId = uri.slice("thunderbird-headers://".length);
    const messageId = Number(rawId);
    if (!rawId || !Number.isInteger(messageId)) {
      throw invalidResourceUri("Invalid Thunderbird headers resource URI", uri);
    }
    result = await callBroker("tool.get_message_headers", { messageId });
  } else if (uri.startsWith("thunderbird-attachment://")) {
    const withoutScheme = uri.slice("thunderbird-attachment://".length);
    const slash = withoutScheme.indexOf("/");
    if (slash === -1) {
      throw invalidResourceUri("Invalid Thunderbird attachment resource URI", uri);
    }
    const messageId = Number(withoutScheme.slice(0, slash));
    const partName = decodeResourcePartName(withoutScheme.slice(slash + 1), uri);
    if (!Number.isInteger(messageId) || !partName) {
      throw invalidResourceUri("Invalid Thunderbird attachment resource URI", uri);
    }
    result = await callBroker("tool.get_attachment", { messageId, partName, format: "metadata" });
  } else {
    throw invalidResourceUri("Unsupported resource URI", uri);
  }

  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(result, null, 2)
      }
    ],
    ...cacheMetadata
  };
}

function decodeResourcePartName(value: string, uri: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw invalidResourceUri("Invalid Thunderbird attachment resource URI", uri);
  }
}

function invalidResourceUri(message: string, uri: string): JsonRpcResponseError {
  return invalidParams(`${message}: ${uri}`, { uri });
}

function invalidParams(message: string, data?: JsonValue): JsonRpcResponseError {
  return new JsonRpcResponseError(-32602, message, data);
}

function handlePromptGet(params: JsonValue | undefined): JsonObject {
  if (!params || typeof params !== "object" || Array.isArray(params) || typeof (params as JsonObject).name !== "string") {
    throw new Error("prompts/get params.name must be a string");
  }

  const name = (params as JsonObject).name as string;
  const args = ((params as JsonObject).arguments ?? {}) as JsonObject;

  if (name === "draft_reply") {
    const tone = typeof args.tone === "string" ? ` Use this tone/style guidance: ${args.tone}` : "";
    return {
      description: "Draft a reply to the current Thunderbird message.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              "Read the current Thunderbird message with get_current_message, summarize the sender's intent, then draft a concise reply with create_reply_draft. Do not send the message." +
              tone
          }
        }
      ]
    };
  }

  if (name === "triage_current_message") {
    return {
      description: "Triage the current Thunderbird message.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              "Read the current Thunderbird message, identify the sender, summarize the email, list action items and deadlines, then suggest whether a reply is needed. Do not create a draft unless I ask."
          }
        }
      ]
    };
  }

  throw new Error(`Unknown prompt: ${name}`);
}
