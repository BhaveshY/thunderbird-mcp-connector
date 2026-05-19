import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ATTACHMENT_SAVE_CHUNK_BYTES } from "../shared/src/constants.js";
import type { JsonObject } from "../shared/src/types.js";

const brokerMocks = vi.hoisted(() => ({
  callBroker: vi.fn(),
  getBrokerStatus: vi.fn()
}));

vi.mock("../host/src/broker-client.js", () => brokerMocks);

import { callTool, isPathInsideOrEqual } from "../host/src/mcp-tools.js";

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
