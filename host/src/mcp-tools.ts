import {
  ATTACHMENT_SAVE_CHUNK_BYTES,
  CONNECTOR_VERSION,
  MAX_ATTACHMENT_SEARCH_LIMIT,
  DEFAULT_SEARCH_PAGE_SIZE,
  DEFAULT_MAX_ATTACHMENT_BYTES,
  DEFAULT_MAX_BODY_CHARS,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_PAGE_SIZE,
  MAX_ATTACHMENT_TOOL_BYTES,
  MAX_SEARCH_LIMIT,
  MCP_SERVER_NAME
} from "../../shared/src/constants.js";
import { mkdir, open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { JsonObject, JsonValue } from "../../shared/src/types.js";
import { callBroker, getBrokerStatus } from "./broker-client.js";
import { ConnectorError } from "./errors.js";
import { canonicalJson, getReplyLedger, hashJson, hashText } from "./reply-ledger.js";

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

const senderIdentityProperty: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["accountId", "identityId", "address"],
  properties: {
    accountId: { type: "string", minLength: 1 },
    identityId: { type: "string", minLength: 1 },
    address: { type: "string", minLength: 3, description: "Exact address exposed by status." }
  }
};

const safeReceiptSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["operationId", "status", "outgoingRfcMessageId", "senderIdentity", "recipients", "sentFolderMessage", "timestamp"],
  properties: {
    operationId: { type: "string" },
    status: { type: "string", enum: ["sent", "queued", "failed", "unknown"] },
    outgoingRfcMessageId: { anyOf: [{ type: "string" }, { type: "null" }] },
    senderIdentity: senderIdentityProperty,
    recipients: { type: "object", additionalProperties: false, required: ["to", "cc", "bcc"], properties: {
      to: { type: "array", items: { type: "string" } }, cc: { type: "array", items: { type: "string" } }, bcc: { type: "array", items: { type: "string" } }
    } },
    sentFolderMessage: { anyOf: [{ type: "object" }, { type: "null" }] },
    timestamp: { type: "string" },
    draftHash: { type: "string" },
    requestId: { anyOf: [{ type: "string" }, { type: "null" }] },
    correlation: { type: "object" },
    evidence: { type: "object" },
    error: { type: "string" }, idempotentReplay: { type: "boolean" }, thunderbirdMode: { type: "string" }
  }
};

const safeReplyBodyProperties: JsonObject = {
  body: { type: "string", description: "Exact body bytes represented as a JSON string." },
  bodyFormat: { type: "string", enum: ["text/plain", "text/html"] }
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
    inputSchema: emptyInputSchema,
    outputSchema: { type: "object", required: ["connected", "connectorName", "connectorVersion", "toolSchemaFingerprint", "capabilities"], properties: {
      connected: { type: "boolean" }, connectorName: { type: "string" }, connectorVersion: { type: "string" },
      toolSchemaFingerprint: { type: "string" }, capabilities: { type: "object" }, connector: { type: "object" }
    } }
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
    title: "Send a Previewed Reply",
    description: "Send exactly a prior preview_reply. This is idempotent and always uses replyToSender/sendNow.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "messageId", "replyType", "senderIdentity", "body", "bodyFormat", "bodyHash", "draftHash",
        "previewToken", "previewHash", "idempotencyKey", "sendNow", "confirmSend"
      ],
      properties: {
        messageId: { type: "integer" },
        replyType: { type: "string", const: "replyToSender" },
        senderIdentity: senderIdentityProperty,
        ...safeReplyBodyProperties,
        bodyHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
        draftHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
        previewToken: { type: "string", minLength: 16 },
        previewHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
        idempotencyKey: { type: "string", minLength: 8, maxLength: 200 },
        requestId: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$" },
        sendNow: { type: "boolean", const: true },
        confirmSend: { type: "boolean", const: true }
      }
    },
    outputSchema: safeReceiptSchema
  },
  {
    name: "poll_messages",
    title: "Poll Thunderbird Messages",
    description: "Poll in stable date/account/folder/RFC-id/Thunderbird-id order using an explicit durable watermark. Returns normalized automation headers.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        accountId: { type: "string" },
        folderId: { type: "string" },
        includeSubFolders: { type: "boolean", default: true },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
        watermark: {
          type: "object", additionalProperties: false,
          required: ["date", "accountId", "folderId", "rfcMessageId", "messageId"],
          properties: {
            date: { type: "string" }, accountId: { type: "string" }, folderId: { type: "string" },
            rfcMessageId: { type: "string" }, messageId: { type: "integer" }
          }
        }
      }
    },
    outputSchema: {
      type: "object", required: ["messages", "count", "watermark", "order"],
      properties: { messages: { type: "array" }, count: { type: "integer" }, watermark: {}, order: { type: "string" } }
    }
  },
  {
    name: "preview_reply",
    title: "Preview a Safe Reply",
    description: "Resolve the exact Thunderbird reply envelope and issue a short-lived, content-bound preview token.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["messageId", "replyType", "senderIdentity", "body", "bodyFormat"],
      properties: {
        messageId: { type: "integer" },
        replyType: { type: "string", const: "replyToSender" },
        senderIdentity: senderIdentityProperty,
        ...safeReplyBodyProperties,
        requestId: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$" }
      }
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "messageId", "replyType", "from", "to", "cc", "bcc", "subject", "inReplyTo", "references", "source",
        "profileFingerprint", "bodyFormat", "bodyHash", "resolvedBodyHash", "envelopeHash", "requestId", "safetyHeaders",
        "previewHash", "previewToken", "draftHash", "expiresAt"
      ],
      properties: {
        messageId: { type: "integer" }, replyType: { type: "string", const: "replyToSender" }, from: senderIdentityProperty,
        to: { type: "array", items: { type: "string" } }, cc: { type: "array", items: { type: "string" } }, bcc: { type: "array", items: { type: "string" } },
        subject: { type: "string" }, inReplyTo: { anyOf: [{ type: "string" }, { type: "null" }] }, references: { type: "array", items: { type: "string" } },
        source: { type: "object" }, profileFingerprint: { type: "string" }, bodyFormat: { type: "string" }, bodyHash: { type: "string" },
        resolvedBodyHash: { type: "string" }, envelopeHash: { type: "string" }, requestId: { anyOf: [{ type: "string" }, { type: "null" }] },
        safetyHeaders: { type: "object" }, previewHash: { type: "string" }, previewToken: { type: "string" }, draftHash: { type: "string" }, expiresAt: { type: "string" }
      }
    }
  },
  {
    name: "get_send_status",
    title: "Get Reply Send Status",
    description: "Read durable host and Thunderbird evidence for an operation without sending.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["operationId"],
      properties: { operationId: { type: "string", minLength: 1 } }
    },
    outputSchema: safeReceiptSchema
  },
  {
    name: "reconcile_send",
    title: "Reconcile an Uncertain Reply",
    description: "Search Thunderbird-managed evidence and Sent/Outbox for an uncertain operation. Never sends mail.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["operationId"],
      properties: { operationId: { type: "string", minLength: 1 } }
    },
    outputSchema: safeReceiptSchema
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
      const connector = await callBroker("tool.connector_status", {});
      return {
        connected: true,
        connectorName: MCP_SERVER_NAME,
        connectorVersion: CONNECTOR_VERSION,
        toolSchemaFingerprint: hashJson(tools as unknown as JsonValue),
        capabilities: {
          previewReply: true,
          persistentIdempotency: true,
          sendReconciliation: true,
          correlationMetadata: true,
          stableExplicitWatermark: true,
          automationPolling: { stableOrdering: true, callerManagedExplicitWatermark: true }
        },
        broker,
        connector
      };
    } catch (error) {
      return {
        connected: false,
        connectorName: MCP_SERVER_NAME,
        connectorVersion: CONNECTOR_VERSION,
        toolSchemaFingerprint: hashJson(tools as unknown as JsonValue),
        capabilities: {
          previewReply: true,
          persistentIdempotency: true,
          sendReconciliation: true,
          correlationMetadata: true,
          stableExplicitWatermark: true,
          automationPolling: { stableOrdering: true, callerManagedExplicitWatermark: true }
        },
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  if (name === "preview_reply") {
    validatePreviewReply(payload);
    const result = validatePreviewResult(asObject(await callBroker("tool.preview_reply", payload), "Invalid preview_reply response."));
    const ledger = await getReplyLedger();
    ledger.recordPreview(result);
    return result;
  }

  if (name === "send_reply") {
    return sendSafeReply(payload);
  }

  if (name === "get_send_status" || name === "reconcile_send") {
    return readOrReconcileSend(name, payload);
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

  if (name === "send_message" || name === "send_current_compose") {
    args.mode = isSendMode(args.mode) ? args.mode : "sendLater";
  }

  if (name === "poll_messages") {
    args.limit = clampInteger(args.limit, 1, 100, 25);
    args.includeSubFolders = typeof args.includeSubFolders === "boolean" ? args.includeSubFolders : true;
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

function validatePreviewReply(args: JsonObject): void {
  requireInteger(args.messageId, "messageId");
  requireConst(args.replyType, "replyToSender", "replyType");
  requireSenderIdentity(args.senderIdentity);
  requireBody(args);
  if (args.requestId !== undefined && (typeof args.requestId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(args.requestId))) {
    throw new ConnectorError("requestId must be a printable token using A-Z, a-z, 0-9, dot, underscore, colon, or dash.", "INVALID_REQUEST_ID");
  }
  for (const field of ["to", "cc", "bcc", "subject", "attachments", "attachment", "replyTo", "headers", "mode"]) {
    if (Object.hasOwn(args, field)) {
      throw new ConnectorError("Recipient, subject, header, mode, and attachment overrides are forbidden for safe replies.", "OVERRIDE_FORBIDDEN");
    }
  }
}

function validateSendReply(args: JsonObject): void {
  validatePreviewReply(args);
  requireConst(args.sendNow, true, "sendNow");
  requireConst(args.confirmSend, true, "confirmSend");
  for (const field of ["previewToken", "previewHash", "bodyHash", "draftHash", "idempotencyKey"]) {
    if (typeof args[field] !== "string" || !(args[field] as string).trim()) {
      throw new ConnectorError(`send_reply requires ${field}.`, "INVALID_ARGUMENTS");
    }
  }
  if (args.bodyHash !== hashText(normalizeBodyText(args.body as string))) {
    throw new ConnectorError("bodyHash does not match the exact body.", "BODY_HASH_MISMATCH");
  }
}

function normalizeBodyText(value: string): string { return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n"); }

async function sendSafeReply(args: JsonObject): Promise<JsonObject> {
  validateSendReply(args);
  const ledger = await getReplyLedger();
  const idempotencyKey = args.idempotencyKey as string;
  const requestHash = hashJson(args);
  const existing = ledger.getByKey(idempotencyKey);
  if (existing) {
    if (existing.requestHash !== requestHash) throw new ConnectorError("This idempotencyKey was already used with different reply content.", "IDEMPOTENCY_CONFLICT");
    if (!existing.receipt) throw new ConnectorError("Existing operation has no durable receipt.", "INVALID_LEDGER_RECEIPT");
    return { ...validateSafeReceipt({ ...existing.receipt, status: publicReceiptStatus(String(existing.receipt.status)) }), idempotentReplay: true };
  }
  const preview = ledger.assertPreview(args);
  assertPreviewBinding(args, preview);
  const proposedOperationId = randomUUID();
  const claim = ledger.claim(idempotencyKey, requestHash, hashJson({
    profileFingerprint: preview.profileFingerprint,
    source: preview.source
  }), proposedOperationId, buildBaseReceipt(proposedOperationId, "unknown", args, preview), args.previewToken as string);
  if (claim.kind === "existing") {
    if (claim.record.receipt) {
      return { ...claim.record.receipt, status: publicReceiptStatus(claim.record.receipt.status as string), idempotentReplay: true };
    }
    return { ...buildBaseReceipt(claim.record.operationId, publicReceiptStatus(claim.record.status), args, preview), idempotentReplay: true };
  }

  const operationId = claim.record.operationId;
  ledger.transition(operationId, "sending", buildBaseReceipt(operationId, "sending", args, preview));
  try {
    const receipt = validateSafeReceipt(asObject(await callBroker("tool.send_reply", { ...args, operationId }), "Invalid send_reply receipt."));
    assertReceiptBinding(receipt, ledger.getByOperationId(operationId)?.receipt ?? null);
    const status = receipt.status as "sent" | "queued" | "failed" | "unknown";
    ledger.transition(operationId, status, receipt);
    return receipt;
  } catch (error) {
    const status = isDefinitivePreSendFailure(error) ? "failed" : "unknown";
    const receipt = buildBaseReceipt(operationId, status, args, preview, error instanceof Error ? error.message : String(error));
    ledger.transition(operationId, status, receipt);
    return receipt;
  }
}

async function readOrReconcileSend(name: string, args: JsonObject): Promise<JsonObject> {
  const operationId = typeof args.operationId === "string" ? args.operationId : "";
  if (!operationId) {
    throw new ConnectorError(`${name} requires operationId.`, "INVALID_ARGUMENTS");
  }
  const ledger = await getReplyLedger();
  const record = ledger.getByOperationId(operationId);
  if (!record) {
    throw new ConnectorError(`Unknown reply operation: ${operationId}`, "OPERATION_NOT_FOUND");
  }

  if (name === "get_send_status") {
    return record.receipt ? { ...record.receipt, status: publicReceiptStatus(record.receipt.status as string) } : {
      operationId,
      status: publicReceiptStatus(record.status),
      timestamp: record.updatedAt
    };
  }

  try {
    const addon = validateSafeReceipt(asObject(await callBroker("tool.reconcile_send", { operationId }), `Invalid ${name} result.`));
    assertReceiptBinding(addon, record.receipt);
    const status = addon.status as "sent" | "queued" | "failed" | "unknown";
    if (canStrengthenStatus(record.status, status) && validateReconciliationEvidence(addon, record.receipt)) {
      ledger.transition(operationId, status, addon);
      return addon;
    }
    return record.receipt ? { ...record.receipt, status: publicReceiptStatus(String(record.receipt.status)) } : operationResult(record, publicReceiptStatus(record.status));
  } catch (error) {
    if (name === "reconcile_send") {
      if (record.status === "unknown") {
        const receipt = record.receipt ? { ...record.receipt, status: "unknown", error: error instanceof Error ? error.message : String(error) } : operationResult(record, "unknown", error instanceof Error ? error.message : String(error));
        ledger.transition(operationId, "unknown", receipt);
        return receipt;
      }
      return record.receipt ?? operationResult(record, publicReceiptStatus(record.status), error instanceof Error ? error.message : String(error));
    }
    return record.receipt ?? operationResult(record, record.status);
  }
}

function assertPreviewBinding(args: JsonObject, preview: JsonObject): void {
  const sender = args.senderIdentity as JsonObject;
  const previewSender = preview.from as JsonObject | undefined;
  if (
    preview.messageId !== args.messageId ||
    preview.replyType !== "replyToSender" ||
    preview.bodyFormat !== args.bodyFormat ||
    previewSender?.accountId !== sender.accountId ||
    previewSender?.identityId !== sender.identityId ||
    String(previewSender?.address ?? "").toLowerCase() !== String(sender.address).toLowerCase()
  ) {
    throw new ConnectorError("Source message, reply type, sender, or format changed after preview.", "PREVIEW_MISMATCH");
  }
}

function operationResult(record: { operationId: string }, status: string, error?: string): JsonObject {
  return {
    operationId: record.operationId,
    status,
    outgoingRfcMessageId: null,
    senderIdentity: {},
    recipients: { to: [], cc: [], bcc: [] },
    sentFolderMessage: null,
    timestamp: new Date().toISOString(),
    ...(error ? { error } : {})
  };
}

function buildBaseReceipt(operationId: string, status: string, args: JsonObject, preview: JsonObject, error?: string): JsonObject {
  return {
    operationId,
    status,
    outgoingRfcMessageId: null,
    senderIdentity: args.senderIdentity as JsonObject,
    recipients: {
      to: preview.to as JsonValue ?? [],
      cc: preview.cc as JsonValue ?? [],
      bcc: preview.bcc as JsonValue ?? []
    },
    sentFolderMessage: null,
    timestamp: new Date().toISOString(),
    draftHash: args.draftHash as string,
    correlation: {
      profileFingerprint: preview.profileFingerprint as JsonValue,
      sourceRfcMessageId: (preview.source as JsonObject)?.rfcMessageId as JsonValue,
      envelopeHash: preview.envelopeHash as JsonValue
    },
    ...(typeof args.requestId === "string" ? { requestId: args.requestId } : {}),
    ...(error ? { error } : {})
  };
}

export function canStrengthenStatus(current: string, next: string): boolean {
  if (current === next) return true;
  if (current === "unknown") return ["sent", "queued", "failed"].includes(next);
  if (current === "queued") return next === "sent";
  return false;
}

function normalizeOperationStatus(value: JsonValue | undefined): "prepared" | "sending" | "sent" | "queued" | "failed" | "unknown" {
  return ["prepared", "sending", "sent", "queued", "failed", "unknown"].includes(String(value))
    ? value as "prepared" | "sending" | "sent" | "queued" | "failed" | "unknown"
    : "unknown";
}

function validatePreviewResult(value: JsonObject): JsonObject {
  const requiredStrings = ["previewToken", "previewHash", "draftHash", "bodyHash", "resolvedBodyHash", "envelopeHash", "expiresAt", "profileFingerprint"];
  if (requiredStrings.some((field) => typeof value[field] !== "string" || !value[field])) {
    throw new ConnectorError("Thunderbird returned an incomplete safe reply preview.", "INVALID_PREVIEW_RESULT");
  }
  for (const field of ["to", "cc", "bcc", "references"]) if (!Array.isArray(value[field])) throw new ConnectorError(`Preview ${field} must be an array.`, "INVALID_PREVIEW_RESULT");
  if (!value.from || !value.source || typeof value.from !== "object" || typeof value.source !== "object") throw new ConnectorError("Preview identity/source is missing.", "INVALID_PREVIEW_RESULT");
  return value;
}

export function validateSafeReceipt(value: JsonObject): JsonObject {
  if (!["sent", "queued", "failed", "unknown"].includes(String(value.status))) throw new ConnectorError("Bridge returned an invalid public send status.", "INVALID_SEND_RECEIPT");
  for (const field of ["operationId", "timestamp", "draftHash"]) if (typeof value[field] !== "string" || !value[field]) throw new ConnectorError(`Receipt is missing ${field}.`, "INVALID_SEND_RECEIPT");
  if (!value.senderIdentity || !value.recipients || typeof value.senderIdentity !== "object" || typeof value.recipients !== "object") throw new ConnectorError("Receipt envelope is missing.", "INVALID_SEND_RECEIPT");
  if (value.status === "sent" && (typeof value.outgoingRfcMessageId !== "string" || !value.outgoingRfcMessageId)) throw new ConnectorError("A sent receipt requires an outgoing RFC Message-ID.", "INVALID_SEND_RECEIPT");
  return value;
}

export function assertReceiptBinding(receipt: JsonObject, expected: JsonObject | null): void {
  if (!expected) throw new ConnectorError("No durable receipt binding exists.", "RECEIPT_BINDING_MISMATCH");
  const scalarFields = ["operationId", "draftHash", "requestId"];
  const identityFields = ["accountId", "identityId", "address"];
  const receiptIdentity = receipt.senderIdentity as JsonObject;
  const expectedIdentity = expected.senderIdentity as JsonObject;
  const receiptRecipients = receipt.recipients as JsonObject;
  const expectedRecipients = expected.recipients as JsonObject;
  const receiptCorrelation = receipt.correlation as JsonObject;
  const expectedCorrelation = expected.correlation as JsonObject;
  const mismatch = scalarFields.some((field) => (receipt[field] ?? null) !== (expected[field] ?? null)) ||
    identityFields.some((field) => receiptIdentity?.[field] !== expectedIdentity?.[field]) ||
    ["to", "cc", "bcc"].some((field) => canonicalJson(receiptRecipients?.[field] as JsonValue) !== canonicalJson(expectedRecipients?.[field] as JsonValue)) ||
    ["profileFingerprint", "sourceRfcMessageId", "envelopeHash"].some((field) => receiptCorrelation?.[field] !== expectedCorrelation?.[field]);
  if (mismatch) throw new ConnectorError("Bridge receipt does not match the durable operation/envelope binding.", "RECEIPT_BINDING_MISMATCH");
}

function validateReconciliationEvidence(receipt: JsonObject, previous: JsonObject | null): boolean {
  if (receipt.status !== "sent" && receipt.status !== "queued") return true;
  const evidence = receipt.evidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) throw new ConnectorError("Terminal reconciliation requires explicit correlation evidence.", "INVALID_RECONCILIATION_EVIDENCE");
  const object = evidence as JsonObject;
  if (object.operationId !== receipt.operationId || object.draftHash !== receipt.draftHash || typeof object.profileFingerprint !== "string" || typeof object.sourceRfcMessageId !== "string" || typeof object.envelopeHash !== "string") {
    throw new ConnectorError("Reconciliation evidence does not bind the operation/profile/source/envelope/draft.", "INVALID_RECONCILIATION_EVIDENCE");
  }
  if (previous?.requestId && object.requestId !== previous.requestId) throw new ConnectorError("Reconciliation request correlation does not match.", "INVALID_RECONCILIATION_EVIDENCE");
  const correlation = previous?.correlation as JsonObject | undefined;
  if (!correlation || object.profileFingerprint !== correlation.profileFingerprint || object.sourceRfcMessageId !== correlation.sourceRfcMessageId || object.envelopeHash !== correlation.envelopeHash) {
    throw new ConnectorError("Reconciliation evidence differs from the durable operation binding.", "INVALID_RECONCILIATION_EVIDENCE");
  }
  return true;
}

function isDefinitivePreSendFailure(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  return [
    "INVALID_ARGUMENTS", "PREVIEW_NOT_FOUND", "PREVIEW_EXPIRED", "PREVIEW_MISMATCH",
    "BODY_HASH_MISMATCH", "SENDER_IDENTITY_MISMATCH", "RECIPIENT_MISMATCH"
  ].includes(code);
}

function requireBody(args: JsonObject): void {
  if (typeof args.body !== "string" || !["text/plain", "text/html"].includes(String(args.bodyFormat))) {
    throw new ConnectorError("A string body and explicit bodyFormat are required.", "INVALID_ARGUMENTS");
  }
}

function requireSenderIdentity(value: JsonValue | undefined): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConnectorError("senderIdentity with identityId and address is required.", "INVALID_ARGUMENTS");
  }
  const identity = value as JsonObject;
  if (typeof identity.accountId !== "string" || typeof identity.identityId !== "string" || typeof identity.address !== "string") {
    throw new ConnectorError("senderIdentity with accountId, identityId, and address is required.", "INVALID_ARGUMENTS");
  }
}

export function publicReceiptStatus(status: string): string {
  return status === "prepared" || status === "sending" ? "unknown" : status;
}

function requireInteger(value: JsonValue | undefined, field: string): void {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ConnectorError(`${field} must be an explicit integer.`, "INVALID_ARGUMENTS");
  }
}

function requireConst(value: JsonValue | undefined, expected: JsonValue, field: string): void {
  if (value !== expected) {
    throw new ConnectorError(`${field} must be ${JSON.stringify(expected)}.`, "INVALID_ARGUMENTS");
  }
}

function asObject(value: JsonValue, message: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConnectorError(message, "INVALID_BRIDGE_RESPONSE");
  }
  return value as JsonObject;
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
