import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JsonObject } from "../shared/src/types.js";
import { ReplyLedger, hashText } from "../host/src/reply-ledger.js";

let tempDir: string;
let databasePath: string;
const ledgers: ReplyLedger[] = [];

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "thunderbird-reply-ledger-"));
  databasePath = join(tempDir, "ledger.sqlite");
});

afterEach(async () => {
  for (const ledger of ledgers.splice(0)) {
    try { ledger.close(); } catch { /* already closed */ }
  }
  await rm(tempDir, { recursive: true, force: true });
});

function ledger(): ReplyLedger {
  const value = new ReplyLedger(databasePath);
  ledgers.push(value);
  return value;
}

function preview(overrides: JsonObject = {}): JsonObject {
  const body = "exact body";
  return {
    previewToken: "secret-preview-token-long-enough",
    previewHash: "a".repeat(64),
    draftHash: "b".repeat(64),
    bodyHash: hashText(body),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    messageId: 7,
    replyType: "replyToSender",
    from: { accountId: "account1", identityId: "id1", address: "sender@example.com" },
    to: ["recipient@example.com"], cc: [], bcc: [], bodyFormat: "text/plain",
    source: { accountId: "account1", folderId: "inbox", messageId: 7, rfcMessageId: "<source@example.com>" },
    ...overrides
  };
}

describe("persistent safe reply ledger", () => {
  it("returns the original receipt for a duplicate key across restart", () => {
    const first = ledger();
    const claim = first.claim("duplicate-key", "request-hash", "source-key");
    expect(claim.kind).toBe("claimed");
    const operationId = claim.record.operationId;
    first.transition(operationId, "sending");
    const receipt = { operationId, status: "sent", outgoingRfcMessageId: "<out@example.com>" };
    first.transition(operationId, "sent", receipt);
    first.close();

    const restarted = ledger();
    const duplicate = restarted.claim("duplicate-key", "request-hash", "source-key");
    expect(duplicate.kind).toBe("existing");
    expect(duplicate.record.receipt).toEqual(receipt);
  });

  it("rejects an idempotency key reused with changed content", () => {
    const store = ledger();
    store.claim("changed-key", "request-a", "source-key");
    expect(() => store.claim("changed-key", "request-b", "source-key")).toThrowError(
      expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" })
    );
  });

  it("does not rewrite a live sending lease and recovers it only after expiry", () => {
    const first = new ReplyLedger(databasePath, 0);
    ledgers.push(first);
    const claim = first.claim("timeout-key", "request-hash", "source-key");
    first.transition(claim.record.operationId, "sending");
    first.close();
    const restarted = ledger();
    expect(restarted.getByOperationId(claim.record.operationId)?.status).toBe("unknown");
  });

  it("uses owner leases and CAS so a second host cannot rewrite a live send", () => {
    const owner = ledger();
    const claim = owner.claim("lease-key", "request", "source");
    owner.transition(claim.record.operationId, "sending");
    const contender = ledger();
    expect(contender.getByOperationId(claim.record.operationId)?.status).toBe("sending");
    expect(() => contender.transition(claim.record.operationId, "unknown")).toThrowError(
      expect.objectContaining({ code: "OPERATION_CONFLICT" })
    );
    expect(owner.transition(claim.record.operationId, "unknown").status).toBe("unknown");
  });

  it("blocks another reply to the same source while an outcome is uncertain or queued", () => {
    const store = ledger();
    const claim = store.claim("first-key", "first-hash", "same-source");
    store.transition(claim.record.operationId, "sending");
    store.transition(claim.record.operationId, "unknown", { operationId: claim.record.operationId, status: "unknown" });
    expect(() => store.claim("second-key", "second-hash", "same-source")).toThrowError(
      expect.objectContaining({ code: "RECONCILIATION_REQUIRED" })
    );
    expect(() => store.claim("other-source", "other-hash", "different-source")).toThrowError(
      expect.objectContaining({ code: "RECONCILIATION_REQUIRED" })
    );
  });

  it("allows reconciliation to strengthen unknown to queued and then sent", () => {
    const store = ledger();
    const claim = store.claim("reconcile-key", "request-hash", "source-key");
    store.transition(claim.record.operationId, "sending");
    store.transition(claim.record.operationId, "unknown");
    store.transition(claim.record.operationId, "queued", { operationId: claim.record.operationId, status: "queued" });
    expect(store.transition(claim.record.operationId, "sent", { operationId: claim.record.operationId, status: "sent" }).status).toBe("sent");
  });

  it("rejects illegal lifecycle regressions", () => {
    const store = ledger();
    const claim = store.claim("transition-key", "request-hash", "source-key");
    expect(() => store.transition(claim.record.operationId, "sent")).toThrowError(
      expect.objectContaining({ code: "ILLEGAL_OPERATION_TRANSITION" })
    );
  });

  it("rejects expired previews and changed body/draft hashes", () => {
    const store = ledger();
    const expired = preview({ expiresAt: new Date(Date.now() - 1).toISOString() });
    store.recordPreview(expired);
    expect(() => store.assertPreview(expired)).toThrowError(expect.objectContaining({ code: "PREVIEW_EXPIRED" }));
    expect(() => store.claim("expired-claim", "hash", "source", undefined, null, expired.previewToken as string)).toThrowError(
      expect.objectContaining({ code: "PREVIEW_EXPIRED" })
    );

    const current = preview({ previewToken: "another-secret-preview-token" });
    store.recordPreview(current);
    expect(() => store.assertPreview({ ...current, draftHash: "c".repeat(64) })).toThrowError(
      expect.objectContaining({ code: "PREVIEW_MISMATCH" })
    );
  });
});
