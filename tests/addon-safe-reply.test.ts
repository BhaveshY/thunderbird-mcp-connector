import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface AddonHarness {
  api: Record<string, (...args: any[]) => any>;
  messenger: any;
  storage: Record<string, any>;
}

async function createHarness(existingStorage: Record<string, any> = {}): Promise<AddonHarness> {
  const storage = existingStorage;
  const source = {
    id: 7,
    subject: "Question",
    author: "Recipient <recipient@example.com>",
    recipients: ["sender@example.com"],
    ccList: [], bccList: [], date: new Date(),
    headerMessageId: "<source@example.com>",
    folder: { id: "inbox", accountId: "account1", name: "Inbox", path: "/Inbox", specialUse: [] }
  };
  let composeState: any = {};
  const messenger: any = {
    runtime: {
      connectNative: () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {} })
    },
    accounts: { list: vi.fn(async () => [{ id: "account1", type: "imap", identities: [{ id: "id1", name: "Sender", email: "sender@example.com" }], rootFolder: null }]) },
    storage: { local: {
      get: vi.fn(async (key: any) => key === null ? { ...storage } : typeof key === "string" ? { [key]: storage[key] } : {}),
      set: vi.fn(async (values: any) => Object.assign(storage, values))
    } },
    messages: {
      get: vi.fn(async () => source),
      getHeaders: vi.fn(async () => ({ "message-id": ["<source@example.com>"], "auto-submitted": ["no"] })),
      query: vi.fn(async () => ({ messages: [] })),
      continueList: vi.fn()
    },
    compose: {
      beginReply: vi.fn(async (_messageId: number, _replyType: string, details: any) => {
        composeState = { identityId: "id1", from: "Sender <sender@example.com>", to: ["recipient@example.com"], cc: [], bcc: [], subject: "Re: Question", ...details };
        return { id: 11 };
      }),
      getComposeDetails: vi.fn(async () => ({ ...composeState })),
      listAttachments: vi.fn(async () => []),
      sendMessage: vi.fn(async () => ({ mode: "sendNow", headerMessageId: "<out@example.com>", messages: [{ ...source, id: 99, headerMessageId: "<out@example.com>", folder: { id: "sent", accountId: "account1", specialUse: ["sent"] } }] }))
    },
    tabs: { remove: vi.fn(async () => undefined), query: vi.fn(async () => []) },
    messageDisplayAction: { onClicked: { addListener() {} } },
    composeAction: { onClicked: { addListener() {} } }
  };
  const context: any = { messenger, crypto, TextEncoder, console, setTimeout: () => 1, clearTimeout, File, Blob, btoa, globalThis: {} };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(await readFile("addon/src/background.js", "utf8"), context, { filename: "background.js" });
  return { api: context.__thunderbirdMcpTest, messenger, storage };
}

function previewInput() {
  return {
    messageId: 7, replyType: "replyToSender",
    senderIdentity: { accountId: "account1", identityId: "id1", address: "sender@example.com" },
    body: "Hello", bodyFormat: "text/plain", requestId: "request-1"
  };
}

describe("add-on safe reply authority", () => {
  let harness: AddonHarness;
  beforeEach(async () => { harness = await createHarness(); });

  it("previews the exact envelope and exposes loop-prevention headers", async () => {
    const result = await harness.api.dispatch("tool.preview_reply", previewInput());
    expect(result).toMatchObject({
      from: { accountId: "account1", identityId: "id1", address: "sender@example.com" },
      to: ["recipient@example.com"], cc: [], bcc: [], subject: "Re: Question",
      inReplyTo: "<source@example.com>",
      source: { accountId: "account1", folderId: "inbox", messageId: 7, rfcMessageId: "<source@example.com>" },
      safetyHeaders: { "auto-submitted": ["no"] }
    });
    expect(result.previewToken).toBeTruthy();
    expect(JSON.stringify(harness.storage)).not.toContain(result.previewToken);
  });

  it("sends once and returns the persisted receipt for a duplicate operation", async () => {
    const preview = await harness.api.dispatch("tool.preview_reply", previewInput());
    const payload = { ...previewInput(), bodyHash: preview.bodyHash, draftHash: preview.draftHash, previewHash: preview.previewHash,
      previewToken: preview.previewToken, operationId: "op-1", idempotencyKey: "idem-key-1", sendNow: true, confirmSend: true };
    const first = await harness.api.dispatch("tool.send_reply", payload);
    const duplicate = await harness.api.dispatch("tool.send_reply", payload);
    expect(first.status).toBe("sent");
    expect(first.outgoingRfcMessageId).toBe("<out@example.com>");
    expect(duplicate).toEqual(first);
    expect(harness.messenger.compose.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent duplicate dispatch and replays after add-on restart", async () => {
    const preview = await harness.api.dispatch("tool.preview_reply", previewInput());
    const payload = { ...previewInput(), bodyHash: preview.bodyHash, draftHash: preview.draftHash, previewHash: preview.previewHash,
      previewToken: preview.previewToken, operationId: "op-concurrent", idempotencyKey: "idem-concurrent", sendNow: true, confirmSend: true };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    harness.messenger.compose.sendMessage.mockImplementationOnce(async () => {
      await gate;
      return { mode: "sendNow", headerMessageId: "<out@example.com>", messages: [{ id: 99, headerMessageId: "<out@example.com>", folder: { id: "sent", accountId: "account1", specialUse: ["sent"] } }] };
    });
    const first = harness.api.dispatch("tool.send_reply", payload);
    const second = harness.api.dispatch("tool.send_reply", payload);
    await Promise.resolve();
    release();
    const [left, right] = await Promise.all([first, second]);
    expect(left).toEqual(right);
    expect(harness.messenger.compose.sendMessage).toHaveBeenCalledTimes(1);

    const restarted = await createHarness(harness.storage);
    expect(await restarted.api.dispatch("tool.send_reply", payload)).toEqual(left);
    expect(restarted.messenger.compose.sendMessage).not.toHaveBeenCalled();
  });

  it("rejects expired previews, changed drafts, wrong sender, recipients, and attachments before send", async () => {
    const preview = await harness.api.dispatch("tool.preview_reply", previewInput());
    const base = { ...previewInput(), bodyHash: preview.bodyHash, draftHash: preview.draftHash, previewHash: preview.previewHash,
      previewToken: preview.previewToken, operationId: "op-fail", idempotencyKey: "idem-fail", sendNow: true, confirmSend: true };
    const previewKey = Object.keys(harness.storage).find((key) => key.startsWith("safeReplyPreview:"))!;
    const currentExpiry = harness.storage[previewKey].expiresAt;
    harness.storage[previewKey].expiresAt = new Date(Date.now() - 1).toISOString();
    await expect(harness.api.dispatch("tool.send_reply", { ...base, operationId: "op-expired" })).rejects.toMatchObject({ code: "PREVIEW_EXPIRED" });
    harness.storage[previewKey].expiresAt = currentExpiry;
    await expect(harness.api.dispatch("tool.send_reply", { ...base, body: "changed" })).rejects.toMatchObject({ code: "PREVIEW_MISMATCH" });
    await expect(harness.api.dispatch("tool.send_reply", { ...base, senderIdentity: { ...base.senderIdentity, address: "wrong@example.com" } })).rejects.toMatchObject({ code: "SENDER_IDENTITY_MISMATCH" });
    harness.messenger.compose.getComposeDetails.mockResolvedValueOnce({ identityId: "id1", to: ["wrong@example.com"], cc: [], bcc: [], subject: "Re: Question" });
    expect((await harness.api.dispatch("tool.send_reply", { ...base, operationId: "op-recipient" })).status).toBe("failed");
    harness.messenger.compose.listAttachments.mockResolvedValueOnce([{ name: "file.txt" }]);
    expect((await harness.api.dispatch("tool.send_reply", { ...base, operationId: "op-attachment" })).status).toBe("failed");
    expect(harness.messenger.compose.sendMessage).not.toHaveBeenCalled();
  });

  it("reports a send exception as unknown and reconciles correlated sent evidence", async () => {
    const preview = await harness.api.dispatch("tool.preview_reply", previewInput());
    const payload = { ...previewInput(), bodyHash: preview.bodyHash, draftHash: preview.draftHash, previewHash: preview.previewHash,
      previewToken: preview.previewToken, operationId: "op-timeout", idempotencyKey: "idem-timeout", sendNow: true, confirmSend: true };
    harness.messenger.compose.sendMessage.mockRejectedValueOnce(new Error("timeout"));
    expect((await harness.api.dispatch("tool.send_reply", payload)).status).toBe("unknown");
    harness.messenger.messages.query.mockResolvedValueOnce({ messages: [{ id: 101, ...await harness.messenger.messages.get(), author: "Sender <sender@example.com>", recipients: ["recipient@example.com"], folder: { id: "sent", accountId: "account1", type: "sent", specialUse: ["sent"] } }] });
    harness.messenger.messages.getHeaders.mockResolvedValueOnce({
      "x-thunderbird-mcp-operation-id": ["op-timeout"], "x-thunderbird-mcp-draft-hash": [preview.draftHash], "x-thunderbird-mcp-request-id": ["request-1"],
      "x-thunderbird-mcp-profile": [preview.profileFingerprint], "x-thunderbird-mcp-source": [await harness.api.sha256Hex("<source@example.com>")],
      "x-thunderbird-mcp-envelope": [preview.envelopeHash]
    });
    harness.messenger.accounts.list.mockResolvedValueOnce([{ id: "account1", identities: [], rootFolder: { id: "root", subFolders: [{ id: "sent", type: "sent", specialUse: ["sent"], subFolders: [] }] } }]);
    expect((await harness.api.dispatch("tool.reconcile_send", { operationId: "op-timeout" })).status).toBe("sent");
  });

  it("reports Thunderbird sendLater as queued, never as sent", async () => {
    const preview = await harness.api.dispatch("tool.preview_reply", previewInput());
    harness.messenger.compose.sendMessage.mockResolvedValueOnce({ mode: "sendLater", messages: [] });
    const receipt = await harness.api.dispatch("tool.send_reply", {
      ...previewInput(), bodyHash: preview.bodyHash, draftHash: preview.draftHash, previewHash: preview.previewHash,
      previewToken: preview.previewToken, operationId: "op-queued", idempotencyKey: "idem-queued", sendNow: true, confirmSend: true
    });
    expect(receipt).toMatchObject({ status: "queued", outgoingRfcMessageId: null, sentFolderMessage: null });
  });

  it("uses Thunderbird's top-level RFC Message-ID when no FCC copy exists", async () => {
    const preview = await harness.api.dispatch("tool.preview_reply", previewInput());
    const payload = { ...previewInput(), bodyHash: preview.bodyHash, draftHash: preview.draftHash, previewHash: preview.previewHash,
      previewToken: preview.previewToken, operationId: "op-no-fcc", idempotencyKey: "idem-no-fcc", sendNow: true, confirmSend: true };
    harness.messenger.compose.sendMessage.mockResolvedValueOnce({ mode: "sendNow", headerMessageId: "<no-fcc@example.com>", messages: [] });
    const receipt = await harness.api.dispatch("tool.send_reply", payload);
    expect(receipt).toMatchObject({ status: "sent", outgoingRfcMessageId: "<no-fcc@example.com>", sentFolderMessage: null });
  });

  it("reconciles queued to sent and accepts deterministic identical FCC copies", async () => {
    const preview = await harness.api.dispatch("tool.preview_reply", previewInput());
    harness.messenger.compose.sendMessage.mockResolvedValueOnce({ mode: "sendLater", messages: [] });
    const payload = { ...previewInput(), bodyHash: preview.bodyHash, draftHash: preview.draftHash, previewHash: preview.previewHash,
      previewToken: preview.previewToken, operationId: "op-fcc", idempotencyKey: "idem-fcc", sendNow: true, confirmSend: true };
    expect((await harness.api.dispatch("tool.send_reply", payload)).status).toBe("queued");
    const outgoing = (id: number) => ({ id, headerMessageId: "<same-out@example.com>", author: "Sender <sender@example.com>",
      recipients: ["recipient@example.com"], ccList: [], bccList: [], date: new Date(), folder: { id: "sent", accountId: "account1", type: "sent", specialUse: ["sent"] } });
    harness.messenger.accounts.list.mockResolvedValueOnce([{ id: "account1", identities: [], rootFolder: { id: "root", subFolders: [{ id: "sent", type: "sent", specialUse: ["sent"], subFolders: [] }] } }]);
    harness.messenger.messages.query.mockResolvedValueOnce({ messages: [outgoing(202), outgoing(201)] });
    const correlationHeaders = {
      "x-thunderbird-mcp-operation-id": ["op-fcc"], "x-thunderbird-mcp-draft-hash": [preview.draftHash], "x-thunderbird-mcp-request-id": ["request-1"],
      "x-thunderbird-mcp-profile": [preview.profileFingerprint], "x-thunderbird-mcp-source": [await harness.api.sha256Hex("<source@example.com>")],
      "x-thunderbird-mcp-envelope": [preview.envelopeHash]
    };
    harness.messenger.messages.getHeaders.mockResolvedValue(correlationHeaders);
    const reconciled = await harness.api.dispatch("tool.reconcile_send", { operationId: "op-fcc" });
    expect(reconciled.status).toBe("sent");
    expect(reconciled.evidence.matchedCopies).toHaveLength(2);
    expect(reconciled.evidence.selectedMessageId).toBe(201);
  });

  it("rejects body/signature and CRLF-normalized compose mutations at the final boundary", async () => {
    const input = { ...previewInput(), body: "Hello\r\nWorld" };
    const preview = await harness.api.dispatch("tool.preview_reply", input);
    const payload = { ...input, bodyHash: preview.bodyHash, draftHash: preview.draftHash, previewHash: preview.previewHash,
      previewToken: preview.previewToken, operationId: "op-body", idempotencyKey: "idem-body", sendNow: true, confirmSend: true };
    const original = harness.messenger.compose.getComposeDetails.getMockImplementation();
    harness.messenger.compose.getComposeDetails.mockImplementationOnce(async () => ({ ...(await original!()), plainTextBody: "Hello\nWorld\n-- changed signature" }));
    const result = await harness.api.dispatch("tool.send_reply", payload);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("final compose body");
    expect(harness.messenger.compose.sendMessage).not.toHaveBeenCalled();
  });

  it("fails closed when Thunderbird mutates the resolved From mailbox", async () => {
    const preview = await harness.api.dispatch("tool.preview_reply", previewInput());
    const payload = { ...previewInput(), bodyHash: preview.bodyHash, draftHash: preview.draftHash, previewHash: preview.previewHash,
      previewToken: preview.previewToken, operationId: "op-from", idempotencyKey: "idem-from", sendNow: true, confirmSend: true };
    const original = harness.messenger.compose.getComposeDetails.getMockImplementation();
    harness.messenger.compose.getComposeDetails.mockImplementationOnce(async () => ({ ...(await original!()), from: "Other <other@example.com>" }));
    const receipt = await harness.api.dispatch("tool.send_reply", payload);
    expect(receipt.status).toBe("failed");
    expect(harness.messenger.compose.sendMessage).not.toHaveBeenCalled();
  });

  it("polls in durable tuple order and resumes strictly after the explicit watermark", async () => {
    const message = (id: number, date: string, rfcMessageId: string) => ({
      id, date: new Date(date), headerMessageId: rfcMessageId, subject: `message-${id}`,
      author: "author@example.com", recipients: ["recipient@example.com"], ccList: [], bccList: [],
      folder: { id: "inbox", accountId: "account1", name: "Inbox", path: "/Inbox", specialUse: [] }
    });
    harness.messenger.messages.query.mockResolvedValueOnce({ messages: [
      message(9, "2026-01-02T00:00:00.000Z", "<z@example.com>"),
      message(2, "2026-01-01T00:00:00.000Z", "<b@example.com>"),
      message(1, "2026-01-01T00:00:00.000Z", "<a@example.com>")
    ] });
    const result = await harness.api.dispatch("tool.poll_messages", {
      accountId: "account1", folderId: "inbox", limit: 10,
      watermark: {
        date: "2026-01-01T00:00:00.000Z", accountId: "account1", folderId: "inbox",
        rfcMessageId: "<a@example.com>", messageId: 1
      }
    });
    expect(result.messages.map((entry: any) => entry.id)).toEqual([2, 9]);
    expect(result.watermark).toEqual({
      date: "2026-01-02T00:00:00.000Z", accountId: "account1", folderId: "inbox",
      rfcMessageId: "<z@example.com>", messageId: 9
    });
    expect(result.order).toContain("rfcMessageId_asc");
  });

  it("exhausts Thunderbird continuation pages before advancing the polling watermark", async () => {
    const message = (id: number, date: string) => ({ id, date: new Date(date), headerMessageId: `<m${id}@example.com>`, subject: `m${id}`,
      author: "a@example.com", recipients: ["r@example.com"], ccList: [], bccList: [], folder: { id: "inbox", accountId: "account1", specialUse: [] } });
    harness.messenger.messages.query.mockResolvedValueOnce({ id: "page-1", messages: [message(1, "2026-01-01T00:00:00Z")] });
    harness.messenger.messages.continueList.mockResolvedValueOnce({ messages: [message(2, "2026-01-02T00:00:00Z")] });
    const result = await harness.api.dispatch("tool.poll_messages", { accountId: "account1", folderId: "inbox", limit: 10 });
    expect(harness.messenger.messages.continueList).toHaveBeenCalledWith("page-1");
    expect(result.messages.map((entry: any) => entry.id)).toEqual([1, 2]);
    expect(result.watermark.messageId).toBe(2);
  });
});
