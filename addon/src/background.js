const NATIVE_HOST_NAME = "com.thunderbird_mcp.bridge";
const DEFAULT_MAX_BODY_CHARS = 100000;
const MAX_SEARCH_LIMIT = 100;
const DEFAULT_MAX_ATTACHMENT_BYTES = 1000000;
const MAX_ATTACHMENT_TOOL_BYTES = 5000000;

let nativePort = null;
let reconnectTimer = null;

connectNativeHost();

function connectNativeHost() {
  if (nativePort) {
    return;
  }

  try {
    nativePort = messenger.runtime.connectNative(NATIVE_HOST_NAME);
    nativePort.onMessage.addListener((message) => {
      handleNativeRequest(message).catch((error) => {
        console.error("Unhandled native request error", error);
      });
    });
    nativePort.onDisconnect.addListener(() => {
      const lastError = messenger.runtime.lastError;
      if (lastError) {
        console.warn("Thunderbird MCP native host disconnected:", lastError.message);
      }
      nativePort = null;
      scheduleReconnect();
    });
    nativePort.postMessage({ id: crypto.randomUUID(), ok: true, result: { ready: true } });
  } catch (error) {
    console.warn("Could not connect Thunderbird MCP native host:", error);
    nativePort = null;
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectNativeHost();
  }, 3000);
}

async function handleNativeRequest(request) {
  if (!request || typeof request !== "object" || typeof request.id !== "string" || typeof request.type !== "string") {
    return;
  }

  try {
    const result = await dispatch(request.type, request.payload || {});
    nativePort?.postMessage({ id: request.id, ok: true, result });
  } catch (error) {
    nativePort?.postMessage({
      id: request.id,
      ok: false,
      error: {
        message: error instanceof Error ? error.message : String(error),
        code: error && typeof error === "object" && "code" in error ? String(error.code) : "ADDON_ERROR"
      }
    });
  }
}

async function dispatch(type, payload) {
  switch (type) {
    case "tool.get_current_message":
      return getCurrentMessage(payload);
    case "tool.get_current_messages":
      return getCurrentMessages(payload);
    case "tool.search_messages":
      return searchMessages(payload);
    case "tool.get_message":
      return getMessage(payload);
    case "tool.get_message_headers":
      return getMessageHeaders(payload);
    case "tool.get_raw_message":
      return getRawMessage(payload);
    case "tool.list_message_text_parts":
      return listMessageTextParts(payload);
    case "tool.list_attachments":
      return listMessageAttachments(payload);
    case "tool.search_attachments":
      return searchAttachments(payload);
    case "tool.get_attachment":
    case "tool.read_attachment":
    case "tool.download_attachment":
      return getAttachment(payload);
    case "tool.open_attachment":
      return openAttachment(payload);
    case "tool.list_folders":
      return listFolders(payload);
    case "tool.open_compose":
      return openCompose(payload);
    case "tool.create_reply_draft":
      return createReplyDraft(payload);
    default:
      throw new Error(`Unsupported Thunderbird bridge request: ${type}`);
  }
}

async function getCurrentMessage(payload = {}) {
  const message = await getDisplayedMessage();
  if (!message) {
    throw new Error("No message is currently displayed in Thunderbird.");
  }
  return getMessage({
    messageId: message.id,
    includeBody: payload.includeBody !== false,
    maxBodyChars: payload.maxBodyChars
  });
}

async function getCurrentMessages(payload = {}) {
  const limit = clampInteger(payload.limit, 1, 50, 10);
  const includeBodies = payload.includeBodies === true;
  const maxBodyChars = clampInteger(payload.maxBodyChars, 1, 500000, DEFAULT_MAX_BODY_CHARS);
  const displayed = await getDisplayedMessagesList();

  if (displayed.length === 0) {
    throw new Error("No messages are currently displayed in Thunderbird.");
  }

  const selected = displayed.slice(0, limit);
  const messages = [];
  for (const message of selected) {
    if (includeBodies) {
      messages.push(await getMessage({ messageId: message.id, includeBody: true, maxBodyChars }));
    } else {
      messages.push(normalizeMessageHeader(message));
    }
  }

  return {
    messages,
    count: messages.length,
    displayedCount: displayed.length,
    truncated: displayed.length > messages.length
  };
}

async function getDisplayedMessage() {
  const messages = await getDisplayedMessagesList();
  return messages.length === 1 ? messages[0] : messages[0] || null;
}

async function getDisplayedMessagesList() {
  const tab = await getActiveTabOrNull();
  if (!tab) {
    return [];
  }

  if (messenger.messageDisplay.getDisplayedMessages) {
    const result = await messenger.messageDisplay.getDisplayedMessages(tab.id);
    return normalizeMessageListResult(result);
  }

  if (messenger.messageDisplay.getDisplayedMessage) {
    const message = await messenger.messageDisplay.getDisplayedMessage(tab.id);
    return message ? [message] : [];
  }

  return [];
}

function normalizeMessageListResult(result) {
  if (!result) {
    return [];
  }
  if (Array.isArray(result)) {
    return result;
  }
  if (Array.isArray(result.messages)) {
    return result.messages;
  }
  return [];
}

async function getMessage(payload = {}) {
  const messageId = Number(payload.messageId);
  if (!Number.isInteger(messageId)) {
    throw new Error("messageId must be an integer.");
  }

  const header = await messenger.messages.get(messageId);
  const result = normalizeMessageHeader(header);

  if (payload.includeBody !== false) {
    const maxBodyChars = clampInteger(payload.maxBodyChars, 1, 500000, DEFAULT_MAX_BODY_CHARS);
    const full = await messenger.messages.getFull(messageId, {
      decodeContent: true,
      decodeHeaders: true,
      decrypt: true
    });
    result.body = extractBody(full, maxBodyChars);
  }

  try {
    const attachments = await messenger.messages.listAttachments(messageId);
    result.attachments = attachments.map(normalizeAttachment);
  } catch (error) {
    result.attachments = [];
  }

  return result;
}

async function getMessageHeaders(payload = {}) {
  const messageId = await resolveMessageId(payload.messageId);
  const message = await messenger.messages.get(messageId);

  if (messenger.messages.getHeaders) {
    const headers = await messenger.messages.getHeaders(messageId);
    return {
      message: normalizeMessageHeader(message),
      headers
    };
  }

  const full = await messenger.messages.getFull(messageId, {
    decodeContent: false,
    decodeHeaders: true,
    decrypt: true
  });

  return {
    message: normalizeMessageHeader(message),
    headers: full.headers || {},
    fallback: true
  };
}

async function getRawMessage(payload = {}) {
  const messageId = await resolveMessageId(payload.messageId);
  const message = await messenger.messages.get(messageId);
  const format = payload.format === "base64" ? "base64" : "text";
  const offsetBytes = clampInteger(payload.offsetBytes, 0, Number.MAX_SAFE_INTEGER, 0);
  const maxBytes = clampInteger(payload.maxBytes, 1, MAX_ATTACHMENT_TOOL_BYTES, DEFAULT_MAX_ATTACHMENT_BYTES);
  const raw = await messenger.messages.getRaw(messageId);
  const file = typeof raw === "string" ? new File([raw], `${messageId}.eml`, { type: "message/rfc822" }) : raw;

  if (format === "text") {
    const maxChars = clampInteger(payload.maxChars, 1, 500000, DEFAULT_MAX_BODY_CHARS);
    const offsetChars = clampInteger(payload.offsetChars, 0, Number.MAX_SAFE_INTEGER, 0);
    const text = await file.text();
    const slice = text.slice(offsetChars, offsetChars + maxChars);
    return {
      message: normalizeMessageHeader(message),
      format: "text",
      text: slice,
      offsetChars,
      nextOffsetChars: offsetChars + slice.length,
      totalChars: text.length,
      truncated: offsetChars + slice.length < text.length
    };
  }

  const end = Math.min(file.size, offsetBytes + maxBytes);
  const buffer = await file.slice(offsetBytes, end).arrayBuffer();
  return {
    message: normalizeMessageHeader(message),
    format: "base64",
    base64: arrayBufferToBase64(buffer),
    offsetBytes,
    nextOffsetBytes: end,
    byteLength: buffer.byteLength,
    totalBytes: file.size,
    truncated: end < file.size
  };
}

async function listMessageTextParts(payload = {}) {
  const messageId = await resolveMessageId(payload.messageId);
  const message = await messenger.messages.get(messageId);
  const maxPartChars = clampInteger(payload.maxPartChars, 1, 500000, DEFAULT_MAX_BODY_CHARS);

  if (messenger.messages.listInlineTextParts) {
    const parts = await messenger.messages.listInlineTextParts(messageId);
    return {
      message: normalizeMessageHeader(message),
      parts: parts.map((part) => normalizeTextPart(part, maxPartChars)),
      count: parts.length
    };
  }

  const full = await messenger.messages.getFull(messageId, {
    decodeContent: true,
    decodeHeaders: true,
    decrypt: true
  });
  const parts = [];
  collectTextParts(full, parts, maxPartChars);
  return {
    message: normalizeMessageHeader(message),
    parts,
    count: parts.length,
    fallback: true
  };
}

async function listMessageAttachments(payload = {}) {
  const messageId = await resolveMessageId(payload.messageId);
  const header = await messenger.messages.get(messageId);
  const attachments = await messenger.messages.listAttachments(messageId);

  return {
    message: normalizeMessageHeader(header),
    attachments: attachments.map(normalizeAttachment),
    count: attachments.length
  };
}

async function searchAttachments(payload = {}) {
  const messageLimit = clampInteger(payload.messageLimit, 1, MAX_SEARCH_LIMIT, 25);
  const attachmentLimit = clampInteger(payload.attachmentLimit, 1, 200, 50);
  const queryInfo = buildMessageQueryInfo(payload, messageLimit);
  queryInfo.attachment = true;

  const filename = typeof payload.filename === "string" ? payload.filename.toLowerCase() : "";
  const extension = normalizeExtension(payload.extension);
  const contentType = typeof payload.contentType === "string" ? payload.contentType.toLowerCase() : "";
  const disposition = ["attachment", "inline"].includes(payload.disposition) ? payload.disposition : "";
  const minSize = Number.isInteger(payload.minSize) ? payload.minSize : null;
  const maxSize = Number.isInteger(payload.maxSize) ? payload.maxSize : null;
  const results = [];

  let inspectedMessages = 0;
  let page = await messenger.messages.query(queryInfo);

  while (page && results.length < attachmentLimit && inspectedMessages < messageLimit) {
    for (const message of page.messages) {
      inspectedMessages += 1;
      const attachments = await messenger.messages.listAttachments(message.id);
      const matchingAttachments = attachments.map(normalizeAttachment).filter((attachment) => {
        if (filename && !(attachment.name || "").toLowerCase().includes(filename)) {
          return false;
        }
        if (extension && !attachmentNameHasExtension(attachment.name || "", extension)) {
          return false;
        }
        if (contentType && !(attachment.contentType || "").toLowerCase().includes(contentType)) {
          return false;
        }
        if (disposition && attachment.contentDisposition !== disposition) {
          return false;
        }
        if (minSize !== null && (attachment.size || 0) < minSize) {
          return false;
        }
        if (maxSize !== null && (attachment.size || 0) > maxSize) {
          return false;
        }
        return true;
      });

      for (const attachment of matchingAttachments) {
        results.push({
          message: normalizeMessageHeader(message),
          attachment
        });
        if (results.length >= attachmentLimit) {
          break;
        }
      }

      if (results.length >= attachmentLimit || inspectedMessages >= messageLimit) {
        break;
      }
    }

    if (!page.id || results.length >= attachmentLimit || inspectedMessages >= messageLimit) {
      if (page.id) {
        await messenger.messages.abortList(page.id);
      }
      break;
    }
    page = await messenger.messages.continueList(page.id);
  }

  return {
    attachments: results,
    count: results.length,
    inspectedMessages,
    messageLimit,
    attachmentLimit
  };
}

async function getAttachment(payload = {}) {
  const messageId = Number(payload.messageId);
  if (!Number.isInteger(messageId)) {
    throw new Error("messageId must be an integer.");
  }
  if (typeof payload.partName !== "string" || !payload.partName.trim()) {
    throw new Error("partName must be a string.");
  }

  const attachments = await messenger.messages.listAttachments(messageId);
  const attachment = attachments.find((candidate) => candidate.partName === payload.partName);
  if (!attachment) {
    throw new Error(`No attachment with partName ${payload.partName} was found on message ${messageId}.`);
  }

  const metadata = normalizeAttachment(attachment);
  const format = ["metadata", "text", "base64"].includes(payload.format) ? payload.format : "text";
  if (format === "metadata") {
    return { messageId, attachment: metadata };
  }

  const file = await messenger.messages.getAttachmentFile(messageId, payload.partName);

  if (format === "text") {
    const forceText = payload.forceText === true;
    if (!forceText && !isTextLike(metadata.contentType || file.type || "")) {
      throw new Error(
        `Attachment ${metadata.name || metadata.partName} has content type ${metadata.contentType || file.type || "unknown"}; request format=base64 or forceText=true to read it as text.`
      );
    }
    const maxChars = clampInteger(payload.maxChars, 1, 500000, DEFAULT_MAX_BODY_CHARS);
    const offsetChars = clampInteger(payload.offsetChars, 0, Number.MAX_SAFE_INTEGER, 0);
    const text = await file.text();
    const slicedText = text.slice(offsetChars, offsetChars + maxChars);
    return {
      messageId,
      attachment: metadata,
      format: "text",
      text: slicedText,
      offsetChars,
      nextOffsetChars: offsetChars + slicedText.length,
      totalChars: text.length,
      truncated: offsetChars + slicedText.length < text.length
    };
  }

  const offsetBytes = clampInteger(payload.offsetBytes, 0, Number.MAX_SAFE_INTEGER, 0);
  const maxBytes = clampInteger(payload.maxBytes, 1, MAX_ATTACHMENT_TOOL_BYTES, DEFAULT_MAX_ATTACHMENT_BYTES);
  const end = Math.min(file.size, offsetBytes + maxBytes);
  const sliced = file.slice(offsetBytes, end);
  const buffer = await sliced.arrayBuffer();
  const base64 = arrayBufferToBase64(buffer);

  return {
    messageId,
    attachment: metadata,
    format: "base64",
    base64,
    offsetBytes,
    nextOffsetBytes: end,
    byteLength: buffer.byteLength,
    totalBytes: file.size,
    truncated: end < file.size
  };
}

async function openAttachment(payload = {}) {
  const messageId = await resolveMessageId(payload.messageId);
  if (typeof payload.partName !== "string" || !payload.partName.trim()) {
    throw new Error("partName must be a string.");
  }

  const tab = await getActiveTab();
  await messenger.messages.openAttachment(messageId, payload.partName, tab.id);

  return {
    messageId,
    partName: payload.partName,
    tabId: tab.id,
    opened: true
  };
}

async function searchMessages(payload = {}) {
  const limit = clampInteger(payload.limit, 1, MAX_SEARCH_LIMIT, 25);
  const queryInfo = buildMessageQueryInfo(payload, limit);

  const messages = [];
  let page = await messenger.messages.query(queryInfo);

  while (page) {
    messages.push(...page.messages.map(normalizeMessageHeader));
    if (messages.length >= limit) {
      if (page.id) {
        await messenger.messages.abortList(page.id);
      }
      break;
    }
    if (!page.id) {
      break;
    }
    page = await messenger.messages.continueList(page.id);
  }

  return {
    messages: messages.slice(0, limit),
    count: Math.min(messages.length, limit),
    limit
  };
}

async function listFolders(payload = {}) {
  const includeSubFolders = payload.includeSubFolders !== false;
  const accounts = await messenger.accounts.list(includeSubFolders);
  return {
    accounts: accounts.map((account) => ({
      id: account.id,
      name: account.name,
      type: account.type,
      identities: (account.identities || []).map((identity) => ({
        id: identity.id,
        name: identity.name,
        email: identity.email
      })),
      rootFolder: normalizeFolder(account.rootFolder, includeSubFolders)
    }))
  };
}

async function openCompose(payload = {}) {
  const details = buildComposeDetails(payload);
  const tab = await messenger.compose.beginNew(undefined, details);
  let saved = null;

  if (payload.saveAsDraft === true) {
    saved = await messenger.compose.saveMessage(tab.id, { mode: "draft" });
  }

  return {
    tabId: tab.id,
    saved
  };
}

async function createReplyDraft(payload = {}) {
  const messageId = await resolveMessageId(payload.messageId);

  const replyType = ["replyToSender", "replyToList", "replyToAll"].includes(payload.replyType)
    ? payload.replyType
    : "replyToSender";

  const details = buildComposeDetails(payload);
  const tab = await messenger.compose.beginReply(messageId, replyType, details);
  let saved = null;

  if (payload.saveAsDraft !== false) {
    saved = await messenger.compose.saveMessage(tab.id, { mode: "draft" });
  }

  return {
    tabId: tab.id,
    messageId,
    replyType,
    saved
  };
}

function buildComposeDetails(payload) {
  const details = {};

  for (const field of ["to", "cc", "bcc"]) {
    if (Array.isArray(payload[field])) {
      details[field] = payload[field].filter((value) => typeof value === "string" && value.trim());
    }
  }

  copyString(payload, details, "subject");

  if (payload.isPlainText === true || typeof payload.plainTextBody === "string") {
    details.isPlainText = true;
    details.plainTextBody = typeof payload.plainTextBody === "string" ? payload.plainTextBody : String(payload.body || "");
  } else if (typeof payload.body === "string") {
    details.isPlainText = false;
    details.body = payload.body;
  }

  return details;
}

function normalizeMessageHeader(message) {
  return {
    id: message.id,
    subject: message.subject,
    author: message.author,
    recipients: message.recipients || [],
    ccList: message.ccList || [],
    bccList: message.bccList || [],
    date: message.date ? new Date(message.date).toISOString() : undefined,
    read: message.read,
    flagged: message.flagged,
    junk: message.junk,
    size: message.size,
    headerMessageId: message.headerMessageId,
    tags: message.tags || [],
    folder: message.folder ? normalizeFolder(message.folder, false) : undefined
  };
}

function normalizeAttachment(attachment) {
  return {
    name: attachment.name,
    contentType: attachment.contentType,
    contentDisposition: attachment.contentDisposition,
    contentId: attachment.contentId,
    size: attachment.size,
    partName: attachment.partName,
    message: attachment.message ? normalizeMessageHeader(attachment.message) : undefined
  };
}

function normalizeTextPart(part, maxPartChars) {
  const body = typeof part.body === "string" ? part.body : "";
  return {
    contentType: part.contentType,
    name: part.name,
    partName: part.partName,
    size: part.size,
    text: body.slice(0, maxPartChars),
    truncated: body.length > maxPartChars
  };
}

function normalizeFolder(folder, includeSubFolders) {
  if (!folder) {
    return undefined;
  }
  return {
    id: folder.id,
    accountId: folder.accountId,
    name: folder.name,
    path: folder.path,
    type: folder.type,
    specialUse: folder.specialUse || [],
    subFolders:
      includeSubFolders && Array.isArray(folder.subFolders)
        ? folder.subFolders.map((subFolder) => normalizeFolder(subFolder, true))
        : undefined
  };
}

function extractBody(part, maxBodyChars) {
  const state = { plain: "", html: "", truncated: false, maxBodyChars };
  collectText(part, state);
  return {
    plain: state.plain || undefined,
    html: state.html || undefined,
    truncated: state.truncated
  };
}

function collectText(part, state) {
  if (!part || typeof part !== "object") {
    return;
  }

  if (typeof part.body === "string" && typeof part.contentType === "string") {
    if (part.contentType.toLowerCase().startsWith("text/plain")) {
      state.plain = appendLimited(state.plain, part.body, state);
    } else if (part.contentType.toLowerCase().startsWith("text/html")) {
      state.html = appendLimited(state.html, part.body, state);
    }
  }

  if (Array.isArray(part.parts)) {
    for (const child of part.parts) {
      collectText(child, state);
    }
  }
}

function collectTextParts(part, parts, maxPartChars) {
  if (!part || typeof part !== "object") {
    return;
  }

  if (typeof part.body === "string" && typeof part.contentType === "string" && part.contentType.toLowerCase().startsWith("text/")) {
    parts.push(normalizeTextPart(part, maxPartChars));
  }

  if (Array.isArray(part.parts)) {
    for (const child of part.parts) {
      collectTextParts(child, parts, maxPartChars);
    }
  }
}

function appendLimited(existing, addition, state) {
  if (state.truncated || existing.length >= state.maxBodyChars) {
    state.truncated = true;
    return existing;
  }

  const remaining = state.maxBodyChars - existing.length;
  if (addition.length > remaining) {
    state.truncated = true;
    return existing + addition.slice(0, remaining);
  }
  return existing + addition;
}

function copyString(source, target, key) {
  if (typeof source[key] === "string" && source[key].trim()) {
    target[key] = source[key];
  }
}

function buildMessageQueryInfo(payload, limit) {
  const queryInfo = {
    messagesPerPage: Math.min(limit, 100),
    autoPaginationTimeout: 500
  };

  copyString(payload, queryInfo, "fullText");
  copyString(payload, queryInfo, "subject");
  copyString(payload, queryInfo, "author");
  copyString(payload, queryInfo, "recipients");
  copyString(payload, queryInfo, "body");
  copyString(payload, queryInfo, "accountId");
  copyString(payload, queryInfo, "folderId");
  copyString(payload, queryInfo, "headerMessageId");

  if (typeof payload.read === "boolean") {
    queryInfo.read = payload.read;
  }
  if (typeof payload.flagged === "boolean") {
    queryInfo.flagged = payload.flagged;
  }
  if (typeof payload.fromMe === "boolean") {
    queryInfo.fromMe = payload.fromMe;
  }
  if (typeof payload.toMe === "boolean") {
    queryInfo.toMe = payload.toMe;
  }
  if (typeof payload.hasAttachments === "boolean") {
    queryInfo.attachment = payload.hasAttachments;
  }
  if (typeof payload.includeSubFolders === "boolean") {
    queryInfo.includeSubFolders = payload.includeSubFolders;
  }
  if (Array.isArray(payload.tags) && payload.tags.every((tag) => typeof tag === "string")) {
    queryInfo.tags = { mode: "all", tags: payload.tags };
  }

  const range = resolveDateRange(payload);
  if (range.fromDate) {
    queryInfo.fromDate = range.fromDate;
  }
  if (range.toDate) {
    queryInfo.toDate = range.toDate;
  }

  if (Number.isInteger(payload.minSize) || Number.isInteger(payload.maxSize)) {
    queryInfo.size = {};
    if (Number.isInteger(payload.minSize)) {
      queryInfo.size.min = payload.minSize;
    }
    if (Number.isInteger(payload.maxSize)) {
      queryInfo.size.max = payload.maxSize;
    }
  }

  return queryInfo;
}

function resolveDateRange(payload) {
  const explicit = {};
  if (typeof payload.fromDate === "string") {
    explicit.fromDate = new Date(payload.fromDate);
  }
  if (typeof payload.toDate === "string") {
    explicit.toDate = new Date(payload.toDate);
  }
  if (explicit.fromDate || explicit.toDate) {
    return explicit;
  }

  if (Number.isInteger(payload.year)) {
    return {
      fromDate: new Date(Date.UTC(payload.year, 0, 1, 0, 0, 0, 0)),
      toDate: new Date(Date.UTC(payload.year, 11, 31, 23, 59, 59, 999))
    };
  }

  const now = new Date();
  const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  switch (payload.datePreset) {
    case "today":
      return { fromDate: startOfToday, toDate: now };
    case "yesterday": {
      const fromDate = new Date(startOfToday);
      fromDate.setUTCDate(fromDate.getUTCDate() - 1);
      const toDate = new Date(startOfToday.getTime() - 1);
      return { fromDate, toDate };
    }
    case "this_year":
      return {
        fromDate: new Date(Date.UTC(now.getUTCFullYear(), 0, 1, 0, 0, 0, 0)),
        toDate: now
      };
    case "last_year":
      return {
        fromDate: new Date(Date.UTC(now.getUTCFullYear() - 1, 0, 1, 0, 0, 0, 0)),
        toDate: new Date(Date.UTC(now.getUTCFullYear() - 1, 11, 31, 23, 59, 59, 999))
      };
    case "last_7_days":
      return fromDaysAgo(now, 7);
    case "last_30_days":
      return fromDaysAgo(now, 30);
    case "last_90_days":
      return fromDaysAgo(now, 90);
    case "last_12_months": {
      const fromDate = new Date(now);
      fromDate.setUTCMonth(fromDate.getUTCMonth() - 12);
      return { fromDate, toDate: now };
    }
    default:
      return {};
  }
}

function fromDaysAgo(now, days) {
  const fromDate = new Date(now);
  fromDate.setUTCDate(fromDate.getUTCDate() - days);
  return { fromDate, toDate: now };
}

function clampInteger(value, min, max, fallback) {
  if (!Number.isInteger(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, value));
}

async function resolveMessageId(value) {
  const messageId = Number(value);
  if (Number.isInteger(messageId)) {
    return messageId;
  }
  const current = await getDisplayedMessage();
  if (!current) {
    throw new Error("No message is currently displayed and no messageId was provided.");
  }
  return current.id;
}

async function getActiveTab() {
  const tabs = await messenger.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab) {
    throw new Error("No active Thunderbird tab was found.");
  }
  return tab;
}

async function getActiveTabOrNull() {
  const tabs = await messenger.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

function isTextLike(contentType) {
  const type = contentType.toLowerCase();
  return (
    type.startsWith("text/") ||
    type.includes("json") ||
    type.includes("xml") ||
    type.includes("csv") ||
    type.includes("calendar")
  );
}

function normalizeExtension(value) {
  if (typeof value !== "string" || !value.trim()) {
    return "";
  }
  return value.trim().toLowerCase().replace(/^\./, "");
}

function attachmentNameHasExtension(name, extension) {
  const lowerName = name.toLowerCase();
  return lowerName.endsWith(`.${extension}`);
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

messenger.messageDisplayAction?.onClicked?.addListener(() => {
  connectNativeHost();
});

messenger.composeAction?.onClicked?.addListener(() => {
  connectNativeHost();
});
