import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractLatestTimestamp,
  scanArchivedMeta,
  fetchArchivedName,
} from "../src/sessions-shared.ts";

let repo = "";
let bare = "";

function run(...args: string[]) {
  execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "dpi-meta-"));
  bare = mkdtempSync(join(tmpdir(), "dpi-meta-bare-"));
  run("init", "-b", "main");
  execFileSync("git", ["init", "--bare", "-b", "main", bare], { stdio: "ignore" });
  run("remote", "add", "origin", bare);
  mkdirSync(join(repo, "sessions", "coder"), { recursive: true });
  writeFileSync(
    join(repo, "sessions/coder/2026-08-01T00-00-00-000Z_a.jsonl"),
    '{"type":"session","timestamp":"2026-08-01T00:00:00Z"}\n{"type":"session_info","name":"命名会话"}\n',
  );
  writeFileSync(
    join(repo, "sessions/coder/2026-08-02T00-00-00-000Z_b.jsonl"),
    '{"type":"session","timestamp":"2026-08-02T00:00:00Z"}\n',
  );
  run("add", "-A");
  run("commit", "-m", "init");
  run("push", "-u", "origin", "main");
  rmSync(join(repo, "sessions"), { recursive: true }); // 模拟稀疏（工作区无 sessions）
});

afterAll(() => {
  rmSync(repo, { recursive: true });
  rmSync(bare, { recursive: true });
});

describe("extractLatestTimestamp", () => {
  it("returns the timestamp of the latest message", () => {
    const text = [
      '{"type":"session","timestamp":"2026-08-01T00:00:00Z"}',
      '{"type":"message","timestamp":"2026-08-01T00:01:00Z","message":{"role":"user","content":"hi"}}',
      '{"type":"message","timestamp":"2026-08-01T00:09:00Z","message":{"role":"assistant","content":"ok"}}',
    ].join("\\n");
    expect(extractLatestTimestamp(text)).toBe(Date.parse("2026-08-01T00:09:00Z"));
  });
});

describe("scanArchivedMeta", () => {
  it("lists sessions from git metadata sorted by filename timestamp desc", async () => {
    const list = await scanArchivedMeta(repo);
    expect(list.length).toBe(2);
    expect(list[0].fileName).toContain("2026-08-02");
    expect(list[0].agent).toBe("coder");
  });
});

describe("fetchArchivedName", () => {
  it("lazily fetches session_info name from a single blob", async () => {
    const name = await fetchArchivedName(repo, "sessions/coder/2026-08-01T00-00-00-000Z_a.jsonl");
    expect(name).toBe("命名会话");
  });
  it("returns empty when no session_info", async () => {
    const name = await fetchArchivedName(repo, "sessions/coder/2026-08-02T00-00-00-000Z_b.jsonl");
    expect(name).toBe("");
  });
});

describe("session-index", () => {
  it("setSessionNameInIndex writes and readSessionIndex reads back", async () => {
    const { setSessionNameInIndex, readSessionIndex, removeSessionFromIndex } =
      await import("../src/session-index.ts");
    const p = "sessions/coder/2026-08-01T00-00-00-000Z_a.jsonl";
    setSessionNameInIndex(repo, p, "OpenSCAD");
    expect(readSessionIndex(repo)[p]?.name).toBe("OpenSCAD");
    removeSessionFromIndex(repo, p);
    expect(readSessionIndex(repo)[p]).toBeUndefined();
  });
});

describe("stripTrailingNonMessage", () => {
  it("removes trailing session_info (restore 空上下文修复)", async () => {
    const { stripTrailingNonMessage } = await import("../src/sessions-shared.ts");
    const text = '{"type":"session","id":"x"}\n{"type":"message","message":{"role":"user","content":"hi"}}\n{"type":"session_info","name":"foo"}\n';
    const out = stripTrailingNonMessage(text);
    expect(out.endsWith('"content":"hi"}}\n')).toBe(true);
    expect(out).not.toContain("session_info");
  });
  it("keeps trailing message untouched", async () => {
    const { stripTrailingNonMessage } = await import("../src/sessions-shared.ts");
    const text = '{"type":"session","id":"x"}\n{"type":"message","message":{"role":"assistant","content":"ok"}}\n';
    expect(stripTrailingNonMessage(text)).toBe(text);
  });
  it("removes multiple trailing non-message entries", async () => {
    const { stripTrailingNonMessage } = await import("../src/sessions-shared.ts");
    const text = '{"type":"session","id":"x"}\n{"type":"message","message":{"role":"user","content":"hi"}}\n{"type":"session_info","name":"a"}\n{"type":"thinking_level_change"}\n';
    const out = stripTrailingNonMessage(text);
    expect(out.endsWith('"content":"hi"}}\n')).toBe(true);
  });
});

describe("sanitizeSessionForRestore", () => {
  it("drops orphan toolResult (no preceding tool_calls)", async () => {
    const { sanitizeSessionForRestore } = await import("../src/sessions-shared.ts");
    const text = [
      '{"type":"session","id":"x"}',
      '{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","id":"t1"}]}}',
      '{"type":"message","message":{"role":"toolResult","toolCallId":"t1"}}',
      '{"type":"message","message":{"role":"toolResult","toolCallId":"t9"}}', // 孤儿
      '{"type":"message","message":{"role":"assistant","content":"ok"}}',
    ].join("\n") + "\n";
    const out = sanitizeSessionForRestore(text);
    expect(out).toContain('"toolCallId":"t1"');
    expect(out).not.toContain('"toolCallId":"t9"'); // 孤儿被移除
    expect(out).toContain('"content":"ok"');
  });
  it("keeps normal toolResult paired with tool_calls", async () => {
    const { sanitizeSessionForRestore } = await import("../src/sessions-shared.ts");
    const text = [
      '{"type":"session","id":"x"}',
      '{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","id":"a"}]}}',
      '{"type":"message","message":{"role":"toolResult","toolCallId":"a"}}',
    ].join("\n") + "\n";
    expect(sanitizeSessionForRestore(text)).toContain('"toolCallId":"a"');
  });
  it("still strips trailing non-message", async () => {
    const { sanitizeSessionForRestore } = await import("../src/sessions-shared.ts");
    const text = '{"type":"session","id":"x"}\n{"type":"message","message":{"role":"user","content":"hi"}}\n{"type":"session_info","name":"n"}\n';
    const out = sanitizeSessionForRestore(text);
    expect(out).not.toContain("session_info");
    expect(out.endsWith('"content":"hi"}}\n')).toBe(true);
  });
});

describe("sanitize aborted/error tool handling", () => {
  it("drops toolResult whose assistant was aborted (pi skips replay)", async () => {
    const { sanitizeSessionForRestore } = await import("../src/sessions-shared.ts");
    const text = [
      '{"type":"session","id":"x"}',
      '{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","id":"a"}],"stopReason":"aborted"}}',
      '{"type":"message","message":{"role":"toolResult","toolCallId":"a"}}',
      '{"type":"message","message":{"role":"assistant","content":"ok"}}',
    ].join("\n") + "\n";
    const out = sanitizeSessionForRestore(text);
    expect(out).not.toContain('"toolCallId":"a"'); // 孤儿 toolResult 被移除
    expect(out).toContain('"content":"ok"');
  });
  it("keeps toolResult for normal assistant (stopReason toolUse)", async () => {
    const { sanitizeSessionForRestore } = await import("../src/sessions-shared.ts");
    const text = [
      '{"type":"session","id":"x"}',
      '{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","id":"b"}],"stopReason":"toolUse"}}',
      '{"type":"message","message":{"role":"toolResult","toolCallId":"b"}}',
    ].join("\n") + "\n";
    expect(sanitizeSessionForRestore(text)).toContain('"toolCallId":"b"');
  });
});
