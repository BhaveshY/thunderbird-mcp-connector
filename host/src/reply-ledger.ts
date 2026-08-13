import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { REPLY_LEDGER_FILE } from "../../shared/src/constants.js";
import type { JsonObject, JsonValue, ReplyOperationStatus } from "../../shared/src/types.js";
import { ConnectorError } from "./errors.js";
import { ensureStateDir, getStateDir } from "./state.js";

interface OperationRow {
  idempotency_key: string;
  operation_id: string;
  request_hash: string;
  source_key: string;
  status: ReplyOperationStatus;
  receipt_json: string | null;
  created_at: string;
  updated_at: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
}

export interface OperationRecord {
  idempotencyKey: string;
  operationId: string;
  requestHash: string;
  status: ReplyOperationStatus;
  receipt: JsonObject | null;
  createdAt: string;
  updatedAt: string;
}

export type ClaimResult =
  | { kind: "claimed"; record: OperationRecord }
  | { kind: "existing"; record: OperationRecord };

export class ReplyLedger {
  private readonly database: DatabaseSync;
  private readonly ownerId = randomUUID();
  private readonly leaseMs: number;

  constructor(path = join(getStateDir(), REPLY_LEDGER_FILE), leaseMs = 60_000) {
    this.leaseMs = leaseMs;
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS reply_operations (
        idempotency_key TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL UNIQUE,
        request_hash TEXT NOT NULL,
        source_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('prepared','sending','sent','queued','failed','unknown')),
        receipt_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        lease_owner TEXT,
        lease_expires_at TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS reply_operations_status_idx ON reply_operations(status);
      CREATE TABLE IF NOT EXISTS reply_previews (
        preview_token TEXT PRIMARY KEY,
        preview_hash TEXT NOT NULL,
        draft_hash TEXT NOT NULL,
        body_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        preview_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
    `);
    ensureColumn(this.database, "reply_operations", "lease_owner", "TEXT");
    ensureColumn(this.database, "reply_operations", "lease_expires_at", "TEXT");
    const now = new Date().toISOString();
    this.database.prepare(`
      UPDATE reply_operations SET status = 'unknown', updated_at = ?, lease_owner = NULL, lease_expires_at = NULL
      WHERE status = 'sending' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
    `).run(now, now);
  }

  close(): void {
    this.database.close();
  }

  recordPreview(preview: JsonObject): void {
    const token = requireString(preview.previewToken, "previewToken");
    const tokenDigest = hashText(token);
    const now = new Date().toISOString();
    const storedPreview = { ...preview };
    delete storedPreview.previewToken;
    this.database.prepare(`
      INSERT OR REPLACE INTO reply_previews
      (preview_token, preview_hash, draft_hash, body_hash, expires_at, preview_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      tokenDigest,
      requireString(preview.previewHash, "previewHash"),
      requireString(preview.draftHash, "draftHash"),
      requireString(preview.bodyHash, "bodyHash"),
      requireString(preview.expiresAt, "expiresAt"),
      JSON.stringify(storedPreview),
      now
    );
  }

  assertPreview(payload: JsonObject): JsonObject {
    const token = requireString(payload.previewToken, "previewToken");
    const tokenDigest = hashText(token);
    const row = this.database.prepare("SELECT * FROM reply_previews WHERE preview_token = ?").get(tokenDigest) as
      | { preview_hash: string; draft_hash: string; body_hash: string; expires_at: string; preview_json: string }
      | undefined;
    if (!row) {
      throw new ConnectorError("The preview token is unknown. Create a new preview_reply first.", "PREVIEW_NOT_FOUND");
    }
    if (Date.parse(row.expires_at) <= Date.now()) {
      throw new ConnectorError("The reply preview has expired. Create a new preview_reply.", "PREVIEW_EXPIRED");
    }
    if (
      payload.previewHash !== row.preview_hash ||
      payload.draftHash !== row.draft_hash ||
      payload.bodyHash !== row.body_hash
    ) {
      throw new ConnectorError("Preview, body, or draft hash does not match the approved preview.", "PREVIEW_MISMATCH");
    }
    return JSON.parse(row.preview_json) as JsonObject;
  }

  claim(
    idempotencyKey: string,
    requestHash: string,
    sourceKey: string,
    operationId = randomUUID(),
    initialReceipt: JsonObject | null = null,
    previewToken?: string
  ): ClaimResult {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.getByKey(idempotencyKey);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new ConnectorError(
            "This idempotencyKey was already used with different reply content.",
            "IDEMPOTENCY_CONFLICT",
            { operationId: existing.operationId, status: existing.status }
          );
        }
        this.database.exec("COMMIT");
        return { kind: "existing", record: existing };
      }

      if (previewToken) {
        const preview = this.database.prepare(
          "SELECT expires_at FROM reply_previews WHERE preview_token = ?"
        ).get(hashText(previewToken)) as { expires_at: string } | undefined;
        if (!preview) throw new ConnectorError("The preview token is unknown.", "PREVIEW_NOT_FOUND");
        if (Date.parse(preview.expires_at) <= Date.now()) {
          throw new ConnectorError("The reply preview expired before the send claim.", "PREVIEW_EXPIRED");
        }
      }

      const uncertain = this.database.prepare(`
        SELECT operation_id, status FROM reply_operations
        WHERE status = 'unknown' OR (source_key = ? AND status IN ('sending', 'queued')) LIMIT 1
      `).get(sourceKey) as { operation_id: string; status: string } | undefined;
      if (uncertain) {
        throw new ConnectorError(
        "An unknown operation, or unresolved reply for this source, must be reconciled before sending another.",
          "RECONCILIATION_REQUIRED",
          { operationId: uncertain.operation_id, status: uncertain.status }
        );
      }

      const now = new Date().toISOString();
      this.database.prepare(`
        INSERT INTO reply_operations
        (idempotency_key, operation_id, request_hash, source_key, status, receipt_json, created_at, updated_at, lease_owner, lease_expires_at)
        VALUES (?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?)
      `).run(idempotencyKey, operationId, requestHash, sourceKey, initialReceipt ? JSON.stringify(initialReceipt) : null, now, now, this.ownerId, new Date(Date.now() + this.leaseMs).toISOString());
      this.database.exec("COMMIT");
      return { kind: "claimed", record: this.getByKey(idempotencyKey)! };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  transition(operationId: string, status: ReplyOperationStatus, receipt: JsonObject | null = null): OperationRecord {
    const current = this.getByOperationId(operationId);
    if (!current) {
      throw new ConnectorError(`Unknown reply operation: ${operationId}`, "OPERATION_NOT_FOUND");
    }
    const allowed: Record<ReplyOperationStatus, ReplyOperationStatus[]> = {
      prepared: ["sending", "failed"],
      sending: ["sent", "queued", "failed", "unknown"],
      unknown: ["sent", "queued", "failed", "unknown"],
      sent: ["sent"], queued: ["queued", "sent"], failed: ["failed"]
    };
    if (!allowed[current.status].includes(status)) {
      throw new ConnectorError(`Illegal operation transition ${current.status} -> ${status}.`, "ILLEGAL_OPERATION_TRANSITION");
    }
    const now = new Date().toISOString();
    const terminal = status !== "sending";
    const result = this.database.prepare(`
      UPDATE reply_operations SET status = ?, receipt_json = ?, updated_at = ?,
        lease_owner = ?, lease_expires_at = ?
      WHERE operation_id = ? AND status = ? AND (lease_owner = ? OR lease_owner IS NULL OR lease_expires_at <= ?)
    `).run(
      status, receipt ? JSON.stringify(receipt) : null, now,
      terminal ? null : this.ownerId, terminal ? null : new Date(Date.now() + this.leaseMs).toISOString(),
      operationId, current.status, this.ownerId, now
    );
    if (result.changes !== 1) {
      throw new ConnectorError("Operation state changed concurrently or is owned by a live sender.", "OPERATION_CONFLICT");
    }
    return this.getByOperationId(operationId)!;
  }

  getByKey(idempotencyKey: string): OperationRecord | null {
    return rowToRecord(this.database.prepare(
      "SELECT * FROM reply_operations WHERE idempotency_key = ?"
    ).get(idempotencyKey) as OperationRow | undefined);
  }

  getByOperationId(operationId: string): OperationRecord | null {
    return rowToRecord(this.database.prepare(
      "SELECT * FROM reply_operations WHERE operation_id = ?"
    ).get(operationId) as OperationRow | undefined);
  }
}

function ensureColumn(database: DatabaseSync, table: string, column: string, type: string): void {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((candidate) => candidate.name === column)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

let sharedLedger: ReplyLedger | null = null;

export async function getReplyLedger(): Promise<ReplyLedger> {
  if (!sharedLedger) {
    await ensureStateDir();
    sharedLedger = new ReplyLedger();
  }
  return sharedLedger;
}

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const object = value as JsonObject;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

export function hashJson(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function rowToRecord(row: OperationRow | undefined): OperationRecord | null {
  if (!row) {
    return null;
  }
  return {
    idempotencyKey: row.idempotency_key,
    operationId: row.operation_id,
    requestHash: row.request_hash,
    status: row.status,
    receipt: row.receipt_json ? JSON.parse(row.receipt_json) as JsonObject : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function requireString(value: JsonValue | undefined, field: string): string {
  if (typeof value !== "string" || !value) {
    throw new ConnectorError(`Preview result is missing ${field}.`, "INVALID_PREVIEW_RESULT");
  }
  return value;
}
