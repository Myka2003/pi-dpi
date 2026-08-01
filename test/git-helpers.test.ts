import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  gitLsTree,
  gitShow,
  gitHashObject,
  gitUpdateIndexCacheInfo,
  gitIndexRemove,
} from "../src/git.ts";

let repo = "";

function run(...args: string[]) {
  execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "dpi-git-"));
  run("init", "-b", "main");
  mkdirSync(join(repo, "sessions", "coder"), { recursive: true });
  writeFileSync(
    join(repo, "sessions/coder/a.jsonl"),
    '{"type":"session","timestamp":"2026-08-01T00:00:00Z"}\n',
  );
  run("add", "-A");
  run("commit", "-m", "init");
  // 模拟稀疏：工作区删掉 sessions，但 index/tree 保留
  rmSync(join(repo, "sessions"), { recursive: true });
});

afterAll(() => rmSync(repo, { recursive: true }));

describe("git helpers", () => {
  it("gitLsTree lists session files with size", async () => {
    const entries = await gitLsTree(repo, "HEAD", "sessions", { noAuth: true });
    expect(entries.length).toBe(1);
    expect(entries[0].path).toBe("sessions/coder/a.jsonl");
    expect(entries[0].blob.length).toBeGreaterThan(0);
  });

  it("gitShow reads a blob not present in worktree", async () => {
    const buf = await gitShow(repo, "HEAD", "sessions/coder/a.jsonl", { noAuth: true });
    expect(buf.toString("utf-8")).toContain('"session"');
  });

  it("hashObject + updateIndexCacheInfo archives without worktree file", async () => {
    const tmp = join(repo, "..", "cur-session.jsonl");
    writeFileSync(tmp, '{"type":"session","timestamp":"2026-08-01T01:00:00Z"}\n');
    const h = await gitHashObject(repo, tmp, { noAuth: true });
    await gitUpdateIndexCacheInfo(repo, "sessions/coder/cur.jsonl", h, { noAuth: true });
    run("commit", "-m", "archive");
    const entries = await gitLsTree(repo, "HEAD", "sessions", { noAuth: true });
    expect(entries.some((e) => e.path === "sessions/coder/cur.jsonl")).toBe(true);
    rmSync(tmp);
  });

  it("gitIndexRemove deletes an archived file", async () => {
    await gitIndexRemove(repo, "sessions/coder/cur.jsonl", { noAuth: true });
    run("commit", "-m", "remove");
    const entries = await gitLsTree(repo, "HEAD", "sessions", { noAuth: true });
    expect(entries.some((e) => e.path === "sessions/coder/cur.jsonl")).toBe(false);
  });
});

describe("gitShow large blob", () => {
  it("reads blob larger than 1MB default maxBuffer", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(repo, "sessions/coder"), { recursive: true });
    const big = join(repo, "sessions/coder/big.jsonl");
    writeFileSync(big, '{"type":"session","timestamp":"2026-08-03T00:00:00Z"}\n' + "x".repeat(2 * 1024 * 1024) + "\n");
    run("add", "-A");
    run("commit", "-m", "big");
    rmSync(join(repo, "sessions"), { recursive: true });
    const buf = await gitShow(repo, "HEAD", "sessions/coder/big.jsonl", { noAuth: true });
    expect(buf.length).toBeGreaterThan(2 * 1024 * 1024);
  });
});
