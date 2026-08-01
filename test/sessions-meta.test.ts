import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanArchivedMeta, fetchArchivedName } from "../src/sessions-shared.ts";

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
