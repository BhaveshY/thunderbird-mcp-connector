# Thunderbird MCP Connector Implementation Plan

## Product Boundary

Version 0.1 is a local-only connector. Claude talks to a local stdio MCP server. The MCP server talks to a local broker started by Thunderbird's native messaging host. The Thunderbird add-on is the only component that reads, drafts, sends, or organizes mail through Thunderbird APIs.

No email content is sent to a remote service by this connector. Claude receives message content only when the user invokes MCP tools or resources.

## Surfaces

- Thunderbird add-on: `addon/`, packaged as `.xpi`. It uses a persistent
  Manifest V2 background page so the native messaging bridge can stay open.
- Thunderbird native host: `thunderbird-mcp native-host`, registered with Mozilla native messaging.
- Claude Code: `thunderbird-mcp mcp` over stdio.
- Claude Desktop: optional `.mcpb` bundle for macOS and Windows.

## Permissions

- `messagesRead`: read displayed messages, message headers, message bodies, and attachments metadata.
- `messagesUpdate`: mark messages read/unread, flagged/unflagged, junk/not junk, and set tag keys.
- `messagesMove`: archive, move, and copy messages through Thunderbird.
- `messagesDelete`: delete messages through Thunderbird. The MCP tool requires `confirmDelete=true`.
- `accountsRead`: list accounts/folders and search within folders.
- `compose`: open compose/reply windows and set compose details.
- `compose.save`: save compose windows as drafts/templates.
- `compose.send`: general new/current-compose sends require `confirmSend=true` and default to `sendLater`; production-safe `send_reply` is a separate preview-bound path that requires `sendNow=true`.
- `nativeMessaging`: communicate with the local native host.
- `storage`: reserved for non-secret add-on state.

## MCP Tools

- `status`: checks local bridge availability.
- `get_current_message`: reads the currently displayed Thunderbird message.
- `get_current_messages`: reads all messages currently displayed in Thunderbird, for multi-select or grouped views.
- `search_messages`: searches Thunderbird's local message index with date presets/year, sender, recipient, size, tag, identity, folder/account, and attachment filters. It returns compact 25-result pages by default and provides `nextPageToken` for deep searches.
- `continue_search`: returns the next compact page for a previous message or attachment search.
- `close_search`: releases a previous paged search token when no more results are needed.
- `get_message`: reads a message by Thunderbird's current internal message id.
- `get_message_headers`: reads decoded RFC 822 headers.
- `get_raw_message`: reads capped raw RFC 822 source as text or base64 with offsets.
- `list_message_text_parts`: lists inline text/plain and text/html message parts.
- `list_attachments`: lists attachment metadata for the current or specified message.
- `search_attachments`: searches messages with attachments and filters by message dates, sender/recipient/subject/body/full-text, folder/account, filename, extension, MIME type, disposition, and size. It inspects attachments concurrently and returns compact pages by default.
- `get_attachment`: retrieves one attachment as metadata, capped text, or explicitly requested capped base64, with offset support.
- `read_attachment`: convenience alias for reading text-like attachment contents with text offsets.
- `download_attachment`: convenience alias for retrieving capped base64 attachment bytes with byte offsets.
- `save_attachment`: saves an attachment to disk using chunked reads, defaulting to `~/Downloads` and avoiding overwrite.
- `open_attachment`: opens an attachment through Thunderbird or the OS handler.
- `list_folders`: lists configured accounts and folders.
- `open_compose`: opens a new compose window, never sends.
- `create_reply_draft`: opens and optionally saves a reply draft, never sends.
- `send_message`: composes and sends or queues a new message, requiring `confirmSend=true`.
- `preview_reply`: resolves the exact reply-to-sender envelope and returns short-lived, content-bound hashes/token.
- `send_reply`: persistently idempotent safe send of exactly a valid preview; requires exact source/sender/body hashes, `sendNow=true`, and `confirmSend=true`.
- `get_send_status` / `reconcile_send`: inspect durable receipts and resolve uncertain sends against Thunderbird and Sent/Outbox correlation evidence.

The final safety boundary is a `compose.getComposeDetails` read immediately before
`compose.sendMessage`. The add-on compares the normalized final plain/HTML body
(including Thunderbird-added signatures), sender identity, recipients, subject,
and all correlation headers, then checks attachments and preview expiry again.
Thunderbird does not currently provide an `onBeforeSend` mutation hook to this
connector, so any future asynchronous mutation outside that final synchronous
boundary must cause an uncertain result and reconciliation rather than a retry.
- `send_current_compose`: sends or queues an existing compose tab, requiring `confirmSend=true`.
- `list_tags`: lists Thunderbird message tags that can be assigned to messages.
- `update_message`: updates read/flagged/junk state or replaces Thunderbird tag keys.
- `archive_messages`: archives messages using Thunderbird's archive settings.
- `move_messages`: moves messages to a folder id returned by `list_folders`.
- `copy_messages`: copies messages to a folder id returned by `list_folders`.
- `delete_messages`: moves messages to Trash by default, requiring `confirmDelete=true`.

## Failure Modes

- Thunderbird closed: MCP tools return `BROKER_NOT_CONNECTED`.
- Add-on disabled: native host will not start; MCP tools return `BROKER_NOT_CONNECTED`.
- Native host missing: add-on logs native messaging failure and reconnects.
- No displayed message: `get_current_message` and default reply draft creation return a clear error.
- Search too broad: message searches are capped to 10,000 inspected results, attachment searches to 5,000 matching attachments, and each response is capped to 100 results.
- Large body: message body is truncated by `maxBodyChars`.
- Large attachment: use `download_attachment` offsets or `save_attachment`; single tool responses are capped.

## Release Artifacts

- `build/thunderbird-mcp-bridge-0.2.0.xpi`
- Native host manifest and wrapper generated by `npm run install-native`
- `build/thunderbird-mcp-0.2.0.mcpb`
- Claude Code config from `npm run claude-config`
