export const EXTENSION_ID = "thunderbird-mcp@local";
export const NATIVE_HOST_NAME = "com.thunderbird_mcp.bridge";
export const MCP_SERVER_NAME = "thunderbird-mcp";
export const MCP_SERVER_TITLE = "Thunderbird MCP";
export const CONNECTOR_VERSION = "0.2.0";

export const STATE_DIR_NAME = ".thunderbird-mcp";
export const BROKER_STATE_FILE = "broker.json";
export const REPLY_LEDGER_FILE = "reply-ledger.sqlite";
export const PREVIEW_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_NATIVE_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_BODY_CHARS = 100_000;
export const DEFAULT_MAX_ATTACHMENT_BYTES = 1_000_000;
export const MAX_ATTACHMENT_TOOL_BYTES = 5_000_000;
export const ATTACHMENT_SAVE_CHUNK_BYTES = 750_000;
export const MAX_SEARCH_LIMIT = 10_000;
export const MAX_ATTACHMENT_SEARCH_LIMIT = 5_000;
export const DEFAULT_SEARCH_PAGE_SIZE = 25;
export const MAX_SEARCH_PAGE_SIZE = 100;
export const DEFAULT_SEARCH_LIMIT = 25;
export const MAX_NATIVE_MESSAGE_BYTES = 32 * 1024 * 1024;
export const MAX_LINE_JSON_BYTES = 32 * 1024 * 1024;

export const PROTOCOL_VERSION = "2026-07-28";
export const LEGACY_PROTOCOL_VERSION = "2025-06-18";
export const SUPPORTED_PROTOCOL_VERSIONS = [PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSION] as const;
