export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface BrokerState {
  version: 1;
  host: "127.0.0.1";
  port: number;
  token: string;
  pid: number;
  nativeHostName: string;
  extensionId: string;
  startedAt: string;
}

export interface BrokerRequest {
  id: string;
  token: string;
  type: string;
  payload?: JsonValue;
}

export interface BrokerResponse {
  id: string;
  ok: boolean;
  result?: JsonValue;
  error?: {
    message: string;
    code?: string;
    details?: JsonValue;
  };
}

export interface NativeBridgeRequest {
  id: string;
  type: string;
  payload?: JsonValue;
}

export interface NativeBridgeResponse {
  id: string;
  ok: boolean;
  result?: JsonValue;
  error?: {
    message: string;
    code?: string;
    details?: JsonValue;
  };
}

export interface NormalizedFolder {
  id: string;
  accountId?: string;
  name?: string;
  path?: string;
  type?: string;
  specialUse?: string[];
  subFolders?: NormalizedFolder[];
}

export interface NormalizedMessageHeader {
  id: number;
  subject?: string;
  author?: string;
  recipients?: string[];
  ccList?: string[];
  bccList?: string[];
  date?: string;
  read?: boolean;
  flagged?: boolean;
  junk?: boolean;
  new?: boolean;
  size?: number;
  headerMessageId?: string;
  folder?: NormalizedFolder;
  tags?: string[];
}

export interface NormalizedMessage extends NormalizedMessageHeader {
  body?: {
    plain?: string;
    html?: string;
    truncated: boolean;
  };
  attachments?: Array<{
    name?: string;
    contentType?: string;
    contentDisposition?: string;
    contentId?: string;
    size?: number;
    partName?: string;
    message?: NormalizedMessageHeader;
  }>;
}

export type ReplyOperationStatus = "prepared" | "sending" | "sent" | "queued" | "failed" | "unknown";

export interface SenderIdentity {
  accountId: string;
  identityId: string;
  address: string;
}

export interface SendReceipt extends JsonObject {
  operationId: string;
  status: ReplyOperationStatus;
  outgoingRfcMessageId: string | null;
  senderIdentity: JsonObject;
  recipients: JsonObject;
  sentFolderMessage: JsonObject | null;
  timestamp: string;
  requestId: string | null;
  draftHash: string;
}
