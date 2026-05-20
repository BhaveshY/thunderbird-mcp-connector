import {
  ATTACHMENT_SAVE_CHUNK_BYTES,
  MAX_ATTACHMENT_SEARCH_LIMIT,
  DEFAULT_SEARCH_PAGE_SIZE,
  DEFAULT_MAX_ATTACHMENT_BYTES,
  DEFAULT_MAX_BODY_CHARS,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_PAGE_SIZE,
  MAX_ATTACHMENT_TOOL_BYTES,
  MAX_SEARCH_LIMIT
} from "../../shared/src/constants.js";
import { mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { JsonObject, JsonValue } from "../../shared/src/types.js";
import { callBroker, getBrokerStatus } from "./broker-client.js";
import { ConnectorError } from "./errors.js";

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonObject;
  outputSchema?: JsonObject;
}

const emptyInputSchema: JsonObject = {
  type: "object",
  additionalProperties: false
};

const dateFilterProperties: JsonObject = {
  fromDate: { type: "string", description: "ISO date/time lower bound." },
  toDate: { type: "string", description: "ISO date/time upper bound." },
  year: { type: "integer", minimum: 1970, maximum: 2100, description: "Shortcut for a full UTC calendar year." },
  datePreset: {
    type: "string",
    enum: ["today", "yesterday", "this_year", "last_year", "last_7_days", "last_30_days", "last_90_days", "last_12_months"],
    description: "Convenience date range. Explicit fromDate/toDate override this."
  }
};

const messageSearchProperties: JsonObject = {
  fullText: { type: "string" },
  subject: { type: "string" },
  author: { type: "string" },
  recipients: { type: "string" },
  body: { type: "string" },
  headerMessageId: { type: "string", description: "The RFC 822 Message-ID header." },
  accountId: {
    anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
    description: "One account id, or multiple account ids when Thunderbird supports array filters."
  },
  folderId: {
    anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
    description: "One folder id, or multiple folder ids when Thunderbird supports array filters."
  },
  includeSubFolders: { type: "boolean", default: true },
  read: { type: "boolean" },
  unread: { type: "boolean", description: "Only unread messages when true, only read messages when false." },
  flagged: { type: "boolean" },
  junk: { type: "boolean" },
  new: { type: "boolean", description: "Only messages Thunderbird currently marks as new." },
  fromMe: { type: "boolean", description: "Only messages from one of the user's identities." },
  toMe: { type: "boolean", description: "Only messages addressed to one of the user's identities." },
  minSize: { type: "integer", minimum: 0, description: "Minimum message size in bytes." },
  maxSize: { type: "integer", minimum: 0, description: "Maximum message size in bytes." },
  tags: {
    type: "array",
    items: { type: "string" },
    description: "Thunderbird tag keys to match, when supported by the local Thunderbird version."
  },
  ...dateFilterProperties
};

const resultFormatProperty: JsonObject = {
  type: "string",
  enum: ["compact", "full"],
  default: "compact",
  description: "Use compact for low-token search results; use full only when detailed metadata is needed."
};

const pageSizeProperty: JsonObject = {
  type: "integer",
  minimum: 1,
  maximum: MAX_SEARCH_PAGE_SIZE,
  default: DEFAULT_SEARCH_PAGE_SIZE,
  description: "Maximum results returned in this response. Use continue_search for the next page."
};

const composeProperties: JsonObject = {
  to: { type: "array", items: { type: "string" } },
  cc: { type: "array", items: { type: "string" } },
  bcc: { type: "array", items: { type: "string" } },
  subject: { type: "string" },
  body: { type: "string", description: "HTML body." },
  plainTextBody: { type: "string" },
  isPlainText: { type: "boolean", default: false }
};

const sendModeProperty: JsonObject = {
  type: "string",
  enum: ["sendLater", "sendNow", "default"],
  default: "sendLater",
  description: "sendLater queues mail in the outbox; sendNow sends immediately; default follows Thunderbird's online/offline behavior."
};

const messageIdsProperty: JsonObject = {
  type: "array",
  minItems: 1,
  items: { type: "integer" }
};

export const tools: ToolDefinition[] = [
  {
    name: "status",
    title: "Thunderbird Bridge Status",
    description: "Check whether Thunderbird and the local native bridge are connected.",
    inputSchema: emptyInputSchema
  },
  {
    name: "get_current_message",
    title: "Get Current Thunderbird Message",
    description: "Read the message currently displayed in Thunderbird.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        includeBody: { type: "boolean", default: true },
        maxBodyChars: { type: "integer", minimum: 1, maximum: 500000, default: DEFAULT_MAX_BODY_CHARS }
      }
    }
  },
  {
    name: "get_current_messages",
    title: "Get Displayed Thunderbird Messages",
    description: "Read all messages currently displayed in Thunderbird. Useful when multiple messages are selected/displayed.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        includeBodies: { type: "boolean", default: false },
        maxBodyChars: { type: "integer", minimum: 1, maximum: 500000, default: DEFAULT_MAX_BODY_CHARS },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 10 }
      }
    }
  },
  {
    name: "search_messages",
    title: "Search Thunderbird Messages",
    description: "Search Thunderbird messages using Thunderbird's local message index.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...messageSearchProperties,
        hasAttachments: { type: "boolean", description: "Filter messages by whether Thunderbird reports attachments." },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_SEARCH_LIMIT,
          default: DEFAULT_SEARCH_LIMIT,
          description: "Total results to inspect across pages."
        },
        pageSize: pageSizeProperty,
        resultFormat: resultFormatProperty
      }
    }
  },
  {
    name: "continue_search",
    title: "Continue Thunderbird Search",
    description: "Return the next compact page from a previous paged search_messages or search_attachments result.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["pageToken"],
      properties: {
        pageToken: { type: "string" },
        pageSize: pageSizeProperty
      }
    }
  },
  {
    name: "close_search",
    title: "Close Thunderbird Search",
    description: "Release a previous paged Thunderbird search token when you do not need more results.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["pageToken"],
      properties: {
        pageToken: { type: "string" }
      }
    }
  },
  {
    name: "get_message",
    title: "Get Thunderbird Message",
    description: "Read a Thunderbird message by its current internal message id.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["messageId"],
      properties: {
        messageId: { type: "integer" },
        includeBody: { type: "boolean", default: true },
        maxBodyChars: { type: "integer", minimum: 1, maximum: 500000, default: DEFAULT_MAX_BODY_CHARS }
      }
    }
  },
  {
    name: "get_message_headers",
    title: "Get Message Headers",
    description: "Read decoded RFC 822 headers for a Thunderbird message, or for the current message if no messageId is provided.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        messageId: { type: "integer", description: "Defaults to the currently displayed message." }
      }
    }
  },
  {
    name: "get_raw_message",
    title: "Get Raw RFC 822 Message",
    description: "Read raw RFC 822 message source as capped text or base64. Use offsets for large messages.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        messageId: { type: "integer", description: "Defaults to the currently displayed message." },
        format: { type: "string", enum: ["text", "base64"], default: "text" },
        offsetBytes: { type: "integer", minimum: 0, default: 0 },
        offsetChars: { type: "integer", minimum: 0, default: 0 },
        maxBytes: { type: "integer", minimum: 1, maximum: MAX_ATTACHMENT_TOOL_BYTES, default: DEFAULT_MAX_ATTACHMENT_BYTES },
        maxChars: { type: "integer", minimum: 1, maximum: 500000, default: DEFAULT_MAX_BODY_CHARS }
      }
    }
  },
  {
    name: "list_message_text_parts",
    title: "List Message Text Parts",
    description: "List Thunderbird's inline text parts for a message. This is useful for plain/html body inspection without attachments.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        messageId: { type: "integer", description: "Defaults to the currently displayed message." },
        maxPartChars: { type: "integer", minimum: 1, maximum: 500000, default: DEFAULT_MAX_BODY_CHARS }
      }
    }
  },
  {
    name: "list_attachments",
    title: "List Message Attachments",
    description: "List attachments for a Thunderbird message, or for the currently displayed message if no messageId is provided.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        messageId: { type: "integer", description: "Defaults to the currently displayed message." }
      }
    }
  },
  {
    name: "search_attachments",
    title: "Search Thunderbird Attachments",
    description: "Search messages with attachments and filter attachment metadata by filename, content type, and size.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...messageSearchProperties,
        filename: { type: "string", description: "Case-insensitive substring match against attachment names." },
        extension: { type: "string", description: "File extension such as pdf, xlsx, csv, or .docx." },
        contentType: { type: "string", description: "Case-insensitive substring match against MIME content type." },
        disposition: {
          type: "string",
          enum: ["attachment", "inline"],
          description: "Filter normal attachments or inline related parts."
        },
        minSize: { type: "integer", minimum: 0 },
        maxSize: { type: "integer", minimum: 0 },
        messageLimit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_SEARCH_LIMIT,
          default: DEFAULT_SEARCH_LIMIT,
          description: "Total messages with attachments to inspect across pages."
        },
        attachmentLimit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_ATTACHMENT_SEARCH_LIMIT,
          default: 50,
          description: "Total matching attachments to return across pages."
        },
        pageSize: pageSizeProperty,
        resultFormat: resultFormatProperty
      }
    }
  },
  {
    name: "get_attachment",
    title: "Get Attachment Content",
    description: "Retrieve one attachment by messageId and partName. Text is returned by default; binary base64 requires an explicit format.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["messageId", "partName"],
      properties: {
        messageId: { type: "integer" },
        partName: { type: "string" },
        format: { type: "string", enum: ["metadata", "text", "base64"], default: "text" },
        forceText: { type: "boolean", default: false },
        offsetBytes: { type: "integer", minimum: 0, default: 0 },
        offsetChars: { type: "integer", minimum: 0, default: 0 },
        maxChars: { type: "integer", minimum: 1, maximum: 500000, default: DEFAULT_MAX_BODY_CHARS },
        maxBytes: { type: "integer", minimum: 1, maximum: MAX_ATTACHMENT_TOOL_BYTES, default: DEFAULT_MAX_ATTACHMENT_BYTES }
      }
    }
  },
  {
    name: "read_attachment",
    title: "Read Attachment Text",
    description: "Read a text-like attachment by messageId and partName. For binary files, use download_attachment or get_attachment with format=base64.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["messageId", "partName"],
      properties: {
        messageId: { type: "integer" },
        partName: { type: "string" },
        forceText: { type: "boolean", default: false },
        offsetChars: { type: "integer", minimum: 0, default: 0 },
        maxChars: { type: "integer", minimum: 1, maximum: 500000, default: DEFAULT_MAX_BODY_CHARS }
      }
    }
  },
  {
    name: "download_attachment",
    title: "Download Attachment Bytes",
    description: "Return one attachment as capped base64 by messageId and partName, for downstream processing of PDFs, DOCX, images, and other binary files.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["messageId", "partName"],
      properties: {
        messageId: { type: "integer" },
        partName: { type: "string" },
        offsetBytes: { type: "integer", minimum: 0, default: 0 },
        maxBytes: { type: "integer", minimum: 1, maximum: MAX_ATTACHMENT_TOOL_BYTES, default: DEFAULT_MAX_ATTACHMENT_BYTES }
      }
    }
  },
  {
    name: "save_attachment",
    title: "Save Attachment Locally",
    description: "Save an attachment to disk using chunked reads. Defaults to the user's Downloads folder and avoids overwriting by default.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["messageId", "partName"],
      properties: {
        messageId: { type: "integer" },
        partName: { type: "string" },
        outputDir: {
          type: "string",
          description: "Optional output directory. Defaults to ~/Downloads. Must be inside the user's home unless allowOutsideHome is true."
        },
        filename: { type: "string", description: "Optional filename override. Defaults to the attachment name." },
        overwrite: { type: "boolean", default: false },
        allowOutsideHome: { type: "boolean", default: false }
      }
    }
  },
  {
    name: "open_attachment",
    title: "Open Thunderbird Attachment",
    description: "Open an attachment in Thunderbird or the OS handler. Works best for the currently displayed message.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["partName"],
      properties: {
        messageId: { type: "integer", description: "Defaults to the currently displayed message." },
        partName: { type: "string" }
      }
    }
  },
  {
    name: "list_folders",
    title: "List Thunderbird Folders",
    description: "List configured Thunderbird accounts and folders.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        includeSubFolders: { type: "boolean", default: true }
      }
    }
  },
  {
    name: "open_compose",
    title: "Open Compose Window",
    description: "Open a Thunderbird compose window with supplied recipients, subject, and body. This never sends mail.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...composeProperties,
        saveAsDraft: { type: "boolean", default: false }
      }
    }
  },
  {
    name: "create_reply_draft",
    title: "Create Reply Draft",
    description: "Open a Thunderbird reply compose window and optionally save it as a draft. This never sends mail.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        messageId: { type: "integer", description: "Defaults to the currently displayed message." },
        replyType: {
          type: "string",
          enum: ["replyToSender", "replyToList", "replyToAll"],
          default: "replyToSender"
        },
        body: { type: "string", description: "HTML body." },
        plainTextBody: { type: "string" },
        isPlainText: { type: "boolean", default: false },
        saveAsDraft: { type: "boolean", default: true }
      }
    }
  },
  {
    name: "send_message",
    title: "Send New Message",
    description: "Compose and send a new Thunderbird message. Requires confirmSend=true. Defaults to sendLater, which queues in the outbox.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["confirmSend"],
      properties: {
        ...composeProperties,
        mode: sendModeProperty,
        confirmSend: {
          type: "boolean",
          const: true,
          description: "Must be true to confirm the message may be sent or queued."
        }
      }
    }
  },
  {
    name: "send_reply",
    title: "Send Reply",
    description: "Create and send a Thunderbird reply. Requires confirmSend=true. Defaults to sendLater, which queues in the outbox.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["confirmSend"],
      properties: {
        messageId: { type: "integer", description: "Defaults to the currently displayed message." },
        replyType: {
          type: "string",
          enum: ["replyToSender", "replyToList", "replyToAll"],
          default: "replyToSender"
        },
        ...composeProperties,
        mode: sendModeProperty,
        confirmSend: {
          type: "boolean",
          const: true,
          description: "Must be true to confirm the reply may be sent or queued."
        }
      }
    }
  },
  {
    name: "send_current_compose",
    title: "Send Current Compose Window",
    description: "Send an existing compose tab by tabId, or the active compose tab if omitted. Requires confirmSend=true.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["confirmSend"],
      properties: {
        tabId: { type: "integer", description: "Defaults to the active Thunderbird tab." },
        mode: sendModeProperty,
        confirmSend: {
          type: "boolean",
          const: true,
          description: "Must be true to confirm the compose window may be sent or queued."
        }
      }
    }
  },
  {
    name: "list_tags",
    title: "List Thunderbird Tags",
    description: "List Thunderbird message tags that can be assigned with update_message.",
    inputSchema: emptyInputSchema
  },
  {
    name: "update_message",
    title: "Update Message State",
    description: "Mark a message read/unread, flagged/unflagged, junk/not junk, or replace its Thunderbird tag keys.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["messageId"],
      properties: {
        messageId: { type: "integer" },
        read: { type: "boolean" },
        flagged: { type: "boolean" },
        junk: { type: "boolean" },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Complete replacement set of Thunderbird tag keys."
        }
      }
    }
  },
  {
    name: "archive_messages",
    title: "Archive Messages",
    description: "Archive messages using Thunderbird's configured archive settings.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["messageIds"],
      properties: {
        messageIds: messageIdsProperty
      }
    }
  },
  {
    name: "move_messages",
    title: "Move Messages",
    description: "Move messages to a Thunderbird folder id returned by list_folders.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["messageIds", "destinationFolderId"],
      properties: {
        messageIds: messageIdsProperty,
        destinationFolderId: { type: "string" }
      }
    }
  },
  {
    name: "copy_messages",
    title: "Copy Messages",
    description: "Copy messages to a Thunderbird folder id returned by list_folders.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["messageIds", "destinationFolderId"],
      properties: {
        messageIds: messageIdsProperty,
        destinationFolderId: { type: "string" }
      }
    }
  },
  {
    name: "delete_messages",
    title: "Delete Messages",
    description: "Move messages to Trash by default, or permanently delete when deletePermanently=true. Requires confirmDelete=true.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["messageIds", "confirmDelete"],
      properties: {
        messageIds: messageIdsProperty,
        deletePermanently: { type: "boolean", default: false },
        confirmDelete: {
          type: "boolean",
          const: true,
          description: "Must be true to confirm messages may be deleted."
        }
      }
    }
  }
];

export async function callTool(name: string, args: JsonValue | undefined): Promise<JsonObject> {
  const payload = normalizeToolArgs(name, args);
  enforceRiskyToolConfirmation(name, payload);

  if (name === "status") {
    try {
      const broker = await getBrokerStatus();
      return {
        connected: true,
        broker
      };
    } catch (error) {
      return {
        connected: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  if (name === "save_attachment") {
    return saveAttachment(payload);
  }

  const result = await callBroker(`tool.${name}`, payload);
  return result && typeof result === "object" && !Array.isArray(result)
    ? (result as JsonObject)
    : { result };
}

function normalizeToolArgs(name: string, raw: JsonValue | undefined): JsonObject {
  const args = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as JsonObject) } : {};

  if (name === "get_current_message" || name === "get_message") {
    args.includeBody = typeof args.includeBody === "boolean" ? args.includeBody : true;
    args.maxBodyChars = clampInteger(args.maxBodyChars, 1, 500_000, DEFAULT_MAX_BODY_CHARS);
  }

  if (name === "get_current_messages") {
    args.includeBodies = typeof args.includeBodies === "boolean" ? args.includeBodies : false;
    args.maxBodyChars = clampInteger(args.maxBodyChars, 1, 500_000, DEFAULT_MAX_BODY_CHARS);
    args.limit = clampInteger(args.limit, 1, 50, 10);
  }

  if (name === "search_messages") {
    args.limit = clampInteger(args.limit, 1, MAX_SEARCH_LIMIT, DEFAULT_SEARCH_LIMIT);
    args.pageSize = clampInteger(args.pageSize, 1, MAX_SEARCH_PAGE_SIZE, DEFAULT_SEARCH_PAGE_SIZE);
    args.resultFormat = args.resultFormat === "full" ? "full" : "compact";
    args.includeSubFolders = typeof args.includeSubFolders === "boolean" ? args.includeSubFolders : true;
  }

  if (name === "continue_search") {
    args.pageSize = clampInteger(args.pageSize, 1, MAX_SEARCH_PAGE_SIZE, DEFAULT_SEARCH_PAGE_SIZE);
  }

  if (name === "get_raw_message") {
    args.format = typeof args.format === "string" ? args.format : "text";
    args.offsetBytes = clampInteger(args.offsetBytes, 0, Number.MAX_SAFE_INTEGER, 0);
    args.offsetChars = clampInteger(args.offsetChars, 0, Number.MAX_SAFE_INTEGER, 0);
    args.maxBytes = clampInteger(args.maxBytes, 1, MAX_ATTACHMENT_TOOL_BYTES, DEFAULT_MAX_ATTACHMENT_BYTES);
    args.maxChars = clampInteger(args.maxChars, 1, 500_000, DEFAULT_MAX_BODY_CHARS);
  }

  if (name === "list_message_text_parts") {
    args.maxPartChars = clampInteger(args.maxPartChars, 1, 500_000, DEFAULT_MAX_BODY_CHARS);
  }

  if (name === "search_attachments") {
    args.messageLimit = clampInteger(args.messageLimit, 1, MAX_SEARCH_LIMIT, DEFAULT_SEARCH_LIMIT);
    args.attachmentLimit = clampInteger(args.attachmentLimit, 1, MAX_ATTACHMENT_SEARCH_LIMIT, 50);
    args.pageSize = clampInteger(args.pageSize, 1, MAX_SEARCH_PAGE_SIZE, DEFAULT_SEARCH_PAGE_SIZE);
    args.resultFormat = args.resultFormat === "full" ? "full" : "compact";
    args.includeSubFolders = typeof args.includeSubFolders === "boolean" ? args.includeSubFolders : true;
  }

  if (name === "get_attachment") {
    args.format = typeof args.format === "string" ? args.format : "text";
    args.maxChars = clampInteger(args.maxChars, 1, 500_000, DEFAULT_MAX_BODY_CHARS);
    args.maxBytes = clampInteger(args.maxBytes, 1, MAX_ATTACHMENT_TOOL_BYTES, DEFAULT_MAX_ATTACHMENT_BYTES);
    args.offsetBytes = clampInteger(args.offsetBytes, 0, Number.MAX_SAFE_INTEGER, 0);
    args.offsetChars = clampInteger(args.offsetChars, 0, Number.MAX_SAFE_INTEGER, 0);
    args.forceText = typeof args.forceText === "boolean" ? args.forceText : false;
  }

  if (name === "read_attachment") {
    args.format = "text";
    args.maxChars = clampInteger(args.maxChars, 1, 500_000, DEFAULT_MAX_BODY_CHARS);
    args.offsetChars = clampInteger(args.offsetChars, 0, Number.MAX_SAFE_INTEGER, 0);
    args.forceText = typeof args.forceText === "boolean" ? args.forceText : false;
  }

  if (name === "download_attachment") {
    args.format = "base64";
    args.maxBytes = clampInteger(args.maxBytes, 1, MAX_ATTACHMENT_TOOL_BYTES, DEFAULT_MAX_ATTACHMENT_BYTES);
    args.offsetBytes = clampInteger(args.offsetBytes, 0, Number.MAX_SAFE_INTEGER, 0);
  }

  if (name === "save_attachment") {
    args.overwrite = typeof args.overwrite === "boolean" ? args.overwrite : false;
    args.allowOutsideHome = typeof args.allowOutsideHome === "boolean" ? args.allowOutsideHome : false;
  }

  if (name === "list_folders") {
    args.includeSubFolders = typeof args.includeSubFolders === "boolean" ? args.includeSubFolders : true;
  }

  if (name === "create_reply_draft") {
    args.replyType = typeof args.replyType === "string" ? args.replyType : "replyToSender";
    args.saveAsDraft = typeof args.saveAsDraft === "boolean" ? args.saveAsDraft : true;
  }

  if (name === "send_message" || name === "send_reply" || name === "send_current_compose") {
    args.mode = isSendMode(args.mode) ? args.mode : "sendLater";
  }

  if (name === "send_reply") {
    args.replyType = typeof args.replyType === "string" ? args.replyType : "replyToSender";
  }

  if (name === "delete_messages") {
    args.deletePermanently = typeof args.deletePermanently === "boolean" ? args.deletePermanently : false;
  }

  if (name === "open_compose") {
    args.saveAsDraft = typeof args.saveAsDraft === "boolean" ? args.saveAsDraft : false;
  }

  return args;
}

function isSendMode(value: JsonValue | undefined): boolean {
  return value === "sendLater" || value === "sendNow" || value === "default";
}

function enforceRiskyToolConfirmation(name: string, args: JsonObject): void {
  if ((name === "send_message" || name === "send_reply" || name === "send_current_compose") && args.confirmSend !== true) {
    throw new ConnectorError(
      "Refusing to send mail without confirmSend=true.",
      "SEND_NOT_CONFIRMED"
    );
  }

  if (name === "delete_messages" && args.confirmDelete !== true) {
    throw new ConnectorError(
      "Refusing to delete messages without confirmDelete=true.",
      "DELETE_NOT_CONFIRMED"
    );
  }
}

function clampInteger(value: JsonValue | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, value));
}

async function saveAttachment(args: JsonObject): Promise<JsonObject> {
  const messageId = typeof args.messageId === "number" && Number.isInteger(args.messageId) ? args.messageId : null;
  const partName = typeof args.partName === "string" && args.partName.trim() ? args.partName : null;
  if (messageId === null || partName === null) {
    throw new ConnectorError("save_attachment requires integer messageId and string partName.", "INVALID_ARGUMENTS");
  }

  const metadataResult = await callBroker("tool.get_attachment", { messageId, partName, format: "metadata" });
  if (!metadataResult || typeof metadataResult !== "object" || Array.isArray(metadataResult)) {
    throw new ConnectorError("Could not read attachment metadata.", "ATTACHMENT_METADATA_FAILED");
  }

  const attachment = (metadataResult as JsonObject).attachment as JsonObject | undefined;
  const rawName = typeof args.filename === "string" && args.filename.trim()
    ? args.filename
    : typeof attachment?.name === "string" && attachment.name.trim()
      ? attachment.name
      : `attachment-${messageId}-${partName}`;
  const filename = sanitizeFilename(rawName);
  const outputDir = resolveOutputDir(args);
  await mkdir(outputDir, { recursive: true });
  const { outputPath, handle } = await openOutputFile(join(outputDir, filename), args.overwrite === true);

  let offsetBytes = 0;
  let chunks = 0;
  let totalBytes = typeof attachment?.size === "number" ? attachment.size : null;

  try {
    while (totalBytes === null || offsetBytes < totalBytes) {
      const chunk = await callBroker("tool.download_attachment", {
        messageId,
        partName,
        offsetBytes,
        maxBytes: ATTACHMENT_SAVE_CHUNK_BYTES,
        format: "base64"
      });
      if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) {
        throw new ConnectorError("Attachment chunk response was not an object.", "ATTACHMENT_CHUNK_FAILED");
      }

      const chunkObject = chunk as JsonObject;
      if (typeof chunkObject.base64 !== "string") {
        throw new ConnectorError("Attachment chunk did not include base64 data.", "ATTACHMENT_CHUNK_FAILED");
      }

      const buffer = Buffer.from(chunkObject.base64, "base64");
      await handle.write(buffer, 0, buffer.length, offsetBytes);
      chunks += 1;
      offsetBytes = typeof chunkObject.nextOffsetBytes === "number"
        ? chunkObject.nextOffsetBytes
        : offsetBytes + buffer.length;
      totalBytes = typeof chunkObject.totalBytes === "number" ? chunkObject.totalBytes : totalBytes;

      if (buffer.length === 0 || chunkObject.truncated !== true) {
        break;
      }
    }
  } finally {
    await handle.close();
  }

  return {
    saved: true,
    path: outputPath,
    bytesWritten: offsetBytes,
    chunks,
    attachment: attachment ?? null
  };
}

function resolveOutputDir(args: JsonObject): string {
  const home = homedir();
  const requested = typeof args.outputDir === "string" && args.outputDir.trim()
    ? args.outputDir
    : join(home, "Downloads");
  const resolved = resolve(requested.replace(/^~(?=$|\/|\\)/, home));
  const homeResolved = resolve(home);

  if (args.allowOutsideHome !== true && !isPathInsideOrEqual(homeResolved, resolved)) {
    throw new ConnectorError(
      "Refusing to save outside the user's home directory unless allowOutsideHome is true.",
      "OUTPUT_DIR_NOT_ALLOWED",
      { outputDir: resolved }
    );
  }

  return resolved;
}

interface PathContainmentOps {
  relative(from: string, to: string): string;
  isAbsolute(path: string): boolean;
}

export function isPathInsideOrEqual(
  parent: string,
  candidate: string,
  pathOps: PathContainmentOps = { relative, isAbsolute }
): boolean {
  const relativePath = pathOps.relative(parent, candidate);
  if (relativePath === "") {
    return true;
  }

  const firstSegment = relativePath.split(/[\\/]/, 1)[0];
  return firstSegment !== ".." && !pathOps.isAbsolute(relativePath);
}

function sanitizeFilename(value: string): string {
  let name = basename(value)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  if (!name || name === "." || name === "..") {
    return "attachment";
  }

  const extension = extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) {
    name = `_${name}`;
  }
  return name || "attachment";
}

async function openOutputFile(path: string, overwrite: boolean): Promise<{ outputPath: string; handle: Awaited<ReturnType<typeof open>> }> {
  if (overwrite) {
    return { outputPath: path, handle: await open(path, "w") };
  }

  const dir = dirname(path);
  const ext = extname(path);
  const stem = basename(path, ext);

  for (let index = 0; index < 10_000; index += 1) {
    const candidate = index === 0 ? path : join(dir, `${stem}-${index}${ext}`);
    try {
      return { outputPath: candidate, handle: await open(candidate, "wx") };
    } catch (error) {
      if (!isFileExistsError(error)) {
        throw error;
      }
    }
  }
  throw new ConnectorError("Could not find a non-existing output filename.", "OUTPUT_PATH_EXISTS");
}

function isFileExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EEXIST";
}
