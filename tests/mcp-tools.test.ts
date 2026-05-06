import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ATTACHMENT_SAVE_CHUNK_BYTES } from "../shared/src/constants.js";
import type { JsonObject } from "../shared/src/types.js";

const brokerMocks = vi.hoisted(() => ({
  callBroker: vi.fn(),
  getBrokerStatus: vi.fn()
}));

vi.mock("../host/src/broker-client.js", () => brokerMocks);

import { callTool } from "../host/src/mcp-tools.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "thunderbird-mcp-tools-test-"));
  brokerMocks.callBroker.mockReset();
  brokerMocks.getBrokerStatus.mockReset();
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("MCP tools", () => {
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
});
