import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repairSessionFile } from "../extensions/session-vcs.ts";

function tmpFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "dpi-test-"));
  const file = join(dir, "session.jsonl");
  writeFileSync(file, content, "utf-8");
  return file;
}

const GOOD_ASSISTANT = JSON.stringify({
  type: "message",
  message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
});
const BAD_ASSISTANT = JSON.stringify({
  type: "message",
  message: { role: "assistant", content: [] },
});
const USER_MSG = JSON.stringify({
  type: "message",
  message: { role: "user", content: [{ type: "text", text: "hi" }] },
});

describe("repairSessionFile 坏消息清理", () => {
  it("删除空 content 的 assistant 消息，其余原样保留", () => {
    const file = tmpFile([GOOD_ASSISTANT, BAD_ASSISTANT, USER_MSG, ""].join("\n"));
    const removed = repairSessionFile(file);
    expect(removed).toBe(1);
    const kept = readFileSync(file, "utf-8");
    expect(kept).toContain(GOOD_ASSISTANT);
    expect(kept).toContain(USER_MSG);
    expect(kept).not.toContain(BAD_ASSISTANT);
    rmSync(file, { recursive: true });
  });

  it("无坏消息时不做任何写入（返回 0）", () => {
    const file = tmpFile([GOOD_ASSISTANT, USER_MSG].join("\n"));
    const before = readFileSync(file, "utf-8");
    expect(repairSessionFile(file)).toBe(0);
    expect(readFileSync(file, "utf-8")).toBe(before);
    rmSync(file, { recursive: true });
  });

  it("无法解析的坏行原样保留，绝不误删", () => {
    const file = tmpFile(["not-json{{{{", BAD_ASSISTANT, USER_MSG].join("\n"));
    expect(repairSessionFile(file)).toBe(1);
    const kept = readFileSync(file, "utf-8");
    expect(kept).toContain("not-json{{{{");
    expect(kept).toContain(USER_MSG);
    rmSync(file, { recursive: true });
  });

  it("user 消息的空 content 不算坏消息（只清理 assistant）", () => {
    const userEmpty = JSON.stringify({
      type: "message",
      message: { role: "user", content: [] },
    });
    const file = tmpFile([userEmpty].join("\n"));
    expect(repairSessionFile(file)).toBe(0);
    expect(readFileSync(file, "utf-8")).toContain(userEmpty);
    rmSync(file, { recursive: true });
  });

  it("文件缺失返回 0，不抛异常", () => {
    expect(repairSessionFile("/nonexistent/path.jsonl")).toBe(0);
  });
});
