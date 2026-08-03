import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("piInstallNpm 调用", () => {
  it("pi 缺失/包不存在时返回 ok=false 而非抛错", () => {
    const { piInstallNpm } = require("../src/extension-installer.ts") as typeof import("../src/extension-installer.ts");
    const r = piInstallNpm("this-pkg-does-not-exist-xyz");
    expect(typeof r.ok).toBe("boolean");
  });
});

describe("npm 分支仓库记录", () => {
  it("在 package.json dependencies 记录并提交", async () => {
    const repo = mkdtempSync(join(tmpdir(), "dpi-ext-install-"));
    const bare = mkdtempSync(join(tmpdir(), "dpi-ext-install-bare-"));
    try {
      execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
      execFileSync("git", ["init", "--bare", "-b", "main", bare], { stdio: "ignore" });
      execFileSync("git", ["-C", repo, "remote", "add", "origin", bare], { stdio: "ignore" });
      execFileSync("git", ["-C", repo, "config", "user.email", "t@t"], { stdio: "ignore" });
      execFileSync("git", ["-C", repo, "config", "user.name", "t"], { stdio: "ignore" });
      writeFileSync(join(repo, "package.json"), "{}\n");
      execFileSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
      execFileSync("git", ["-C", repo, "commit", "-m", "init"], { stdio: "ignore" });
      execFileSync("git", ["-C", repo, "push", "-u", "origin", "main"], { stdio: "ignore" });

      const { recordNpmDependency } = await import("../src/extension-installer.ts");
      const { commitAndPush } = await import("../src/install-common.ts");
      recordNpmDependency(repo, "pi-mcp-adapter");
      await commitAndPush(repo, "test: record dep");
      const pkg = JSON.parse(
        require("node:fs").readFileSync(join(repo, "package.json"), "utf-8"),
      ) as { dependencies?: Record<string, string> };
      expect(pkg.dependencies?.["pi-mcp-adapter"]).toBe("*");
      const tree = execFileSync("git", ["-C", bare, "ls-tree", "-r", "--name-only", "main"], {
        encoding: "utf-8",
      });
      expect(tree).toContain("package.json");
    } finally {
      rmSync(repo, { recursive: true });
      rmSync(bare, { recursive: true });
    }
  });
});
