import { describe, expect, it } from "vitest";
import { escapeWindowsCmdBatchArgument } from "../host/src/install.js";

describe("native host installer helpers", () => {
  it("escapes cmd metacharacters for Windows batch wrappers", () => {
    expect(escapeWindowsCmdBatchArgument("C:\\Users\\A%TEMP%^Beta\\node.exe")).toBe(
      "C:\\Users\\A%%TEMP%%^^Beta\\node.exe"
    );
  });
});
