import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ATTACHMENT_SAVE_CHUNK_BYTES, MAX_SEARCH_LIMIT } from "../shared/src/constants.js";
import type { JsonObject } from "../shared/src/types.js";

const brokerMocks = vi.hoisted(() => ({
  callBroker: vi.fn(),
  getBrokerStatus: vi.fn()
}));

vi.mock("../host/src/broker-client.js", () => brokerMocks);

import { assertReceiptBinding, callTool, canStrengthenStatus, isPathInsideOrEqual, publicReceiptStatus, validateSafeReceipt } from "../host/src/mcp-tools.js";

let tempDir: string;
const LARGE_SEARCH_LIMIT = 1000;
const DEFAULT_SEARCH_PAGE_SIZE = 25;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "thunderbird-mcp-tools-test-"));
  brokerMocks.callBroker.mockReset();
  brokerMocks.getBrokerStatus.mockReset();
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("MCP tools", () => {
  it("maps live internal sending to public unknown and rejects malformed bridge receipts", () => {
    expect(publicReceiptStatus("sending")).toBe("unknown");
    expect(() => validateSafeReceipt({ operationId: "op", status: "prepared" })).toThrowError(
      expect.objectContaining({ code: "INVALID_SEND_RECEIPT" })
    );
    expect(() => validateSafeReceipt({
      operationId: "op", status: "sent", outgoingRfcMessageId: null, timestamp: new Date().toISOString(), draftHash: "x",
      senderIdentity: { accountId: "a", identityId: "i", address: "a@example.com" }, recipients: { to: [], cc: [], bcc: [] }
    })).toThrowError(expect.objectContaining({ code: "INVALID_SEND_RECEIPT" }));
  });

  it("rejects adversarial receipt rebinding and never accepts a status downgrade", () => {
    const expected = {
      operationId: "op-1", status: "unknown", outgoingRfcMessageId: null, timestamp: new Date().toISOString(), draftHash: "d",
      requestId: "req-1", senderIdentity: { accountId: "a", identityId: "i", address: "sender@example.com" },
      recipients: { to: ["to@example.com"], cc: [], bcc: [] }, sentFolderMessage: null,
      correlation: { profileFingerprint: "p", sourceRfcMessageId: "<s>", envelopeHash: "e" }
    } as JsonObject;
    expect(() => assertReceiptBinding({ ...expected, operationId: "attacker" }, expected)).toThrowError(expect.objectContaining({ code: "RECEIPT_BINDING_MISMATCH" }));
    expect(() => assertReceiptBinding({ ...expected, correlation: { ...(expected.correlation as JsonObject), envelopeHash: "wrong" } }, expected)).toThrowError(expect.objectContaining({ code: "RECEIPT_BINDING_MISMATCH" }));
    expect(canStrengthenStatus("queued", "unknown")).toBe(false);
    expect(canStrengthenStatus("sent", "failed")).toBe(false);
  });
  it("allows larger message searches through to the bridge", async () => {
    brokerMocks.callBroker.mockResolvedValue({ messages: [], count: 0, limit: LARGE_SEARCH_LIMIT });

    await callTool("search_messages", { subject: "invoice", limit: LARGE_SEARCH_LIMIT });

    expect(brokerMocks.callBroker).toHaveBeenCalledWith("tool.search_messages", {
      subject: "invoice",
      limit: LARGE_SEARCH_LIMIT,
      pageSize: DEFAULT_SEARCH_PAGE_SIZE,
      resultFormat: "compact",
      includeSubFolders: true
    });
  });

  it("clamps oversized message searches to the supported maximum", async () => {
    brokerMocks.callBroker.mockResolvedValue({ messages: [], count: 0, limit: MAX_SEARCH_LIMIT });

    await callTool("search_messages", { limit: MAX_SEARCH_LIMIT + 1 });

    expect(brokerMocks.callBroker).toHaveBeenCalledWith("tool.search_messages", {
      limit: MAX_SEARCH_LIMIT,
      pageSize: DEFAULT_SEARCH_PAGE_SIZE,
      resultFormat: "compact",
      includeSubFolders: true
    });
  });

  it("routes search continuation with compact paging defaults", async () => {
    brokerMocks.callBroker.mockResolvedValue({ messages: [], count: 0 });

    await callTool("continue_search", { pageToken: "search_123" });

    expect(brokerMocks.callBroker).toHaveBeenCalledWith("tool.continue_search", {
      pageToken: "search_123",
      pageSize: DEFAULT_SEARCH_PAGE_SIZE
    });
  });

  it("clamps attachment search page size and defaults to compact results", async () => {
    brokerMocks.callBroker.mockResolvedValue({ attachments: [], count: 0 });

    await callTool("search_attachments", {
      author: "Aaron",
      extension: "xlsx",
      messageLimit: LARGE_SEARCH_LIMIT,
      attachmentLimit: LARGE_SEARCH_LIMIT,
      pageSize: 500
    });

    expect(brokerMocks.callBroker).toHaveBeenCalledWith("tool.search_attachments", {
      author: "Aaron",
      extension: "xlsx",
      messageLimit: LARGE_SEARCH_LIMIT,
      attachmentLimit: LARGE_SEARCH_LIMIT,
      pageSize: 100,
      resultFormat: "compact",
      includeSubFolders: true
    });
  });

  it("requires explicit confirmation before sending a new message", async () => {
    await expect(
      callTool("send_message", {
        to: ["recipient@example.com"],
        subject: "Hello",
        plainTextBody: "Hi"
      })
    ).rejects.toMatchObject({
      code: "SEND_NOT_CONFIRMED"
    });
    expect(brokerMocks.callBroker).not.toHaveBeenCalled();
  });

  it("routes confirmed new message sends through the bridge", async () => {
    brokerMocks.callBroker.mockResolvedValue({ sent: true, mode: "sendLater" });

    const result = await callTool("send_message", {
      to: ["recipient@example.com"],
      subject: "Hello",
      plainTextBody: "Hi",
      confirmSend: true
    });

    expect(brokerMocks.callBroker).toHaveBeenCalledWith("tool.send_message", {
      to: ["recipient@example.com"],
      subject: "Hello",
      plainTextBody: "Hi",
      confirmSend: true,
      mode: "sendLater"
    });
    expect(result.sent).toBe(true);
  });

  it("requires the exact safe-reply contract and rejects sender or recipient changes", async () => {
    const base = {
      messageId: 7,
      replyType: "replyToSender",
      senderIdentity: { accountId: "account1", identityId: "id1", address: "sender@example.com" },
      body: "hello",
      bodyFormat: "text/plain",
      bodyHash: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      draftHash: "b".repeat(64),
      previewToken: "preview-token-long-enough",
      previewHash: "a".repeat(64),
      idempotencyKey: "safe-key-123",
      sendNow: true,
      confirmSend: true
    };

    await expect(callTool("send_reply", { ...base, to: ["attacker@example.com"] })).rejects.toMatchObject({
      code: "OVERRIDE_FORBIDDEN"
    });
    await expect(callTool("send_reply", {
      ...base,
      senderIdentity: { identityId: "id1", address: "sender@example.com" }
    })).rejects.toMatchObject({ code: "INVALID_ARGUMENTS" });
    await expect(callTool("send_reply", { ...base, body: "changed" })).rejects.toMatchObject({
      code: "BODY_HASH_MISMATCH"
    });
    expect(brokerMocks.callBroker).not.toHaveBeenCalled();
  });

  it("requires explicit confirmation before deleting messages", async () => {
    await expect(callTool("delete_messages", { messageIds: [7] })).rejects.toMatchObject({
      code: "DELETE_NOT_CONFIRMED"
    });
    expect(brokerMocks.callBroker).not.toHaveBeenCalled();
  });

  it("routes confirmed deletes through the bridge", async () => {
    brokerMocks.callBroker.mockResolvedValue({ deleted: true, messageIds: [7], deletePermanently: false });

    const result = await callTool("delete_messages", { messageIds: [7], confirmDelete: true });

    expect(brokerMocks.callBroker).toHaveBeenCalledWith("tool.delete_messages", {
      messageIds: [7],
      confirmDelete: true,
      deletePermanently: false
    });
    expect(result.deleted).toBe(true);
  });

  it("saves attachments by explicitly requesting base64 chunks", async () => {
    const downloadPayloads: JsonObject[] = [];
    brokerMocks.callBroker.mockImplementation(async (type: string, payload: JsonObject) => {
      if (type === "tool.get_attachment") {
        return {
          messageId: payload.messageId,
          attachment: {
            name: "protocol.xlsx",
            partName: payload.partName,
            size: 5
          }
        };
      }

      if (type === "tool.download_attachment") {
        downloadPayloads.push(payload);
        if (payload.format !== "base64") {
          return {
            format: "text",
            text: "hello",
            totalBytes: 5,
            truncated: false
          };
        }

        return {
          format: "base64",
          base64: Buffer.from("hello").toString("base64"),
          offsetBytes: 0,
          nextOffsetBytes: 5,
          totalBytes: 5,
          truncated: false
        };
      }

      throw new Error(`Unexpected broker call: ${type}`);
    });

    const result = await callTool("save_attachment", {
      messageId: 4,
      partName: "1.2",
      outputDir: tempDir,
      filename: "protocol.xlsx",
      overwrite: true,
      allowOutsideHome: true
    });

    expect(downloadPayloads).toEqual([
      {
        messageId: 4,
        partName: "1.2",
        offsetBytes: 0,
        maxBytes: ATTACHMENT_SAVE_CHUNK_BYTES,
        format: "base64"
      }
    ]);
    expect(await readFile(result.path as string, "utf8")).toBe("hello");
    expect(result.bytesWritten).toBe(5);
  });

  it("uses an atomic suffix when saving without overwrite", async () => {
    await writeFile(join(tempDir, "protocol.xlsx"), "original");

    brokerMocks.callBroker.mockImplementation(async (type: string, payload: JsonObject) => {
      if (type === "tool.get_attachment") {
        return {
          messageId: payload.messageId,
          attachment: {
            name: "protocol.xlsx",
            partName: payload.partName,
            size: 5
          }
        };
      }

      if (type === "tool.download_attachment") {
        return {
          format: "base64",
          base64: Buffer.from("hello").toString("base64"),
          offsetBytes: 0,
          nextOffsetBytes: 5,
          totalBytes: 5,
          truncated: false
        };
      }

      throw new Error(`Unexpected broker call: ${type}`);
    });

    const result = await callTool("save_attachment", {
      messageId: 4,
      partName: "1.2",
      outputDir: tempDir,
      filename: "protocol.xlsx",
      allowOutsideHome: true
    });

    expect(basename(result.path as string)).toBe("protocol-1.xlsx");
    expect(await readFile(join(tempDir, "protocol.xlsx"), "utf8")).toBe("original");
    expect(await readFile(result.path as string, "utf8")).toBe("hello");
  });

  it("sanitizes unsafe Windows filenames before saving", async () => {
    brokerMocks.callBroker.mockImplementation(async (type: string, payload: JsonObject) => {
      if (type === "tool.get_attachment") {
        return {
          messageId: payload.messageId,
          attachment: {
            name: "ignored.txt",
            partName: payload.partName,
            size: 0
          }
        };
      }

      throw new Error(`Unexpected broker call: ${type}`);
    });

    const traversal = await callTool("save_attachment", {
      messageId: 4,
      partName: "1.2",
      outputDir: tempDir,
      filename: "..",
      overwrite: true,
      allowOutsideHome: true
    });
    const reserved = await callTool("save_attachment", {
      messageId: 4,
      partName: "1.2",
      outputDir: tempDir,
      filename: "CON.txt",
      overwrite: true,
      allowOutsideHome: true
    });

    expect(basename(traversal.path as string)).toBe("attachment");
    expect(basename(reserved.path as string)).toBe("_CON.txt");
  });

  it("recognizes Windows child paths without allowing sibling prefixes", () => {
    expect(isPathInsideOrEqual("C:\\Users\\Ada", "C:\\Users\\Ada\\Downloads", win32)).toBe(true);
    expect(isPathInsideOrEqual("C:\\Users\\Ada", "C:\\Users\\Ada\\..safe", win32)).toBe(true);
    expect(isPathInsideOrEqual("C:\\Users\\Ada", "C:\\Users\\Ada2\\Downloads", win32)).toBe(false);
    expect(isPathInsideOrEqual("C:\\Users\\Ada", "D:\\Users\\Ada\\Downloads", win32)).toBe(false);
  });
});
