import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitAndPush } from "../src/install-common.ts";

let repo = "";
let bare = "";
function run(...args: string[]) {
  execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "dpi-install-"));
  bare = mkdtempSync(join(tmpdir(), "dpi-install-bare-"));
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  execFileSync("git", ["init", "--bare", "-b", "main", bare], { stdio: "ignore" });
  run("remote", "add", "origin", bare);
  run("config", "user.email", "t@t");
  run("config", "user.name", "t");
  // 模拟真实内容仓库：已有初始提交且 main 跟踪 origin/main
  const { writeFileSync } = require("node:fs") as typeof import("node:fs");
  writeFileSync(join(repo, "README.md"), "# repo\n");
  run("add", "-A");
  run("commit", "-m", "init");
  run("push", "-u", "origin", "main");
});

afterAll(() => {
  rmSync(repo, { recursive: true });
  rmSync(bare, { recursive: true });
});

describe("commitAndPush", () => {
  it("提交并推送后远端可见", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(repo, "skills", "x"), { recursive: true });
    writeFileSync(join(repo, "skills/x/SKILL.md"), "# X\n");
    const ok = await commitAndPush(repo, "test: add skill x");
    expect(ok).toBe(true);
    const tree = execFileSync("git", ["-C", bare, "ls-tree", "-r", "--name-only", "main"], {
      encoding: "utf-8",
    });
    expect(tree).toContain("skills/x/SKILL.md");
  });

  it("无变更时不抛错并返回 false", async () => {
    const ok = await commitAndPush(repo, "test: noop");
    expect(ok).toBe(false);
  });
});
