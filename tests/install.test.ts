import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureBuiltCliPath, escapeWindowsCmdBatchArgument } from "../host/src/install.js";

describe("native host installer helpers", () => {
  it("escapes cmd metacharacters for Windows batch wrappers", () => {
    expect(escapeWindowsCmdBatchArgument("C:\\Users\\A%TEMP%^Beta\\node.exe")).toBe(
      "C:\\Users\\A%%TEMP%%^^Beta\\node.exe"
    );
  });

  it("fails clearly when install-native is run before build output exists", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "thunderbird-mcp-install-test-"));
    try {
      await expect(ensureBuiltCliPath(join(tempDir, "dist", "host", "src", "cli.js"))).rejects.toMatchObject({
        code: "CLI_NOT_BUILT"
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
