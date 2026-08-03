import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let server: Server;
let apiBase = "";
let rawBase = "";
let repo = "";
let bare = "";
function run(...args: string[]) {
  execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const p = new URL(req.url!, apiBase).pathname;
    if (p.endsWith("/contents/skills")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify([{ name: "open-websearch", type: "dir" }]));
      return;
    }
    if (p.endsWith("/contents/skills/open-websearch")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify([{ name: "SKILL.md", type: "file" }]));
      return;
    }
    if (p.endsWith("/SKILL.md")) {
      res.end("---\nname: open-websearch\n---\n# Open WebSearch\n");
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ default_branch: "main" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  apiBase = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  rawBase = apiBase;

  repo = mkdtempSync(join(tmpdir(), "dpi-skills-install-"));
  bare = mkdtempSync(join(tmpdir(), "dpi-skills-install-bare-"));
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  execFileSync("git", ["init", "--bare", "-b", "main", bare], { stdio: "ignore" });
  run("remote", "add", "origin", bare);
  run("config", "user.email", "t@t");
  run("config", "user.name", "t");
  mkdirSync(join(repo, "skills"), { recursive: true });
  writeFileSync(join(repo, "skills/.gitkeep"), "");
  run("add", "-A");
  run("commit", "-m", "init");
  run("push", "-u", "origin", "main");
});

afterAll(() => {
  server.close();
  rmSync(repo, { recursive: true });
  rmSync(bare, { recursive: true });
});

describe("installSkill 落库", () => {
  it("从模拟 GitHub 安装 skill 并提交", async () => {
    const { installSkillWithBase } = await import("../src/skill-installer.ts");
    const fakeCtx = {
      ui: {
        notify: () => {},
        select: async () => undefined,
        input: async () => undefined,
      },
    } as never;
    const ok = await installSkillWithBase(fakeCtx, repo, "aas-ee/open-websearch", {
      apiBase,
      rawBase,
      proxy: "",
    });
    expect(ok).toBe(true);
    expect(existsSync(join(repo, "skills/open-websearch/SKILL.md"))).toBe(true);
    const tree = execFileSync("git", ["-C", bare, "ls-tree", "-r", "--name-only", "main"], {
      encoding: "utf-8",
    });
    expect(tree).toContain("skills/open-websearch/SKILL.md");
  });
});

describe("分类仓库 + --skill 指定", () => {
  let server: Server;
  let base = "";
  let repo2 = "";
  let bare2 = "";
  function run2(...args: string[]) {
    execFileSync("git", ["-C", repo2, ...args], { stdio: "ignore" });
  }

  beforeAll(async () => {
    server = createServer((req, res) => {
      const p = new URL(req.url!, base).pathname;
      if (p.endsWith("/contents/skills")) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify([{ name: "engineering", type: "dir" }]));
        return;
      }
      if (p.endsWith("/contents/skills/engineering")) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify([
          { name: "tdd", type: "dir" },
          { name: "code-review", type: "dir" },
        ]));
        return;
      }
      if (p.endsWith("/contents/skills/engineering/tdd")) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify([{ name: "SKILL.md", type: "file" }]));
        return;
      }
      if (p.endsWith("/contents/skills/engineering/code-review")) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify([{ name: "SKILL.md", type: "file" }]));
        return;
      }
      if (p.endsWith("/SKILL.md")) { res.end("---\nname: tdd\n---\n# TDD\n"); return; }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ default_branch: "main" }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    repo2 = mkdtempSync(join(tmpdir(), "dpi-skills-cat-"));
    bare2 = mkdtempSync(join(tmpdir(), "dpi-skills-cat-bare-"));
    execFileSync("git", ["init", "-b", "main", repo2], { stdio: "ignore" });
    execFileSync("git", ["init", "--bare", "-b", "main", bare2], { stdio: "ignore" });
    run2("remote", "add", "origin", bare2);
    run2("config", "user.email", "t@t");
    run2("config", "user.name", "t");
    mkdirSync(join(repo2, "skills"), { recursive: true });
    writeFileSync(join(repo2, "skills/.gitkeep"), "");
    run2("add", "-A"); run2("commit", "-m", "init"); run2("push", "-u", "origin", "main");
  });
  afterAll(() => {
    server.close();
    rmSync(repo2, { recursive: true });
    rmSync(bare2, { recursive: true });
  });

  it("--skill tdd 精确安装分类仓库中的 skill（落库为 skills/tdd）", async () => {
    const { installSkillWithBase } = await import("../src/skill-installer.ts");
    const fakeCtx = { ui: { notify: () => {}, select: async () => undefined, input: async () => undefined } } as never;
    const ok = await installSkillWithBase(
      fakeCtx,
      repo2,
      "https://github.com/mattpocock/skills --skill tdd",
      { apiBase: base, rawBase: base, proxy: "" },
    );
    expect(ok).toBe(true);
    expect(existsSync(join(repo2, "skills/tdd/SKILL.md"))).toBe(true);
    expect(existsSync(join(repo2, "skills/engineering"))).toBe(false);
  });
});
