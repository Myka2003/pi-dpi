import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { parseInstallSource, githubOwnerRepo } from "../src/github-source.ts";

describe("githubOwnerRepo", () => {
  it("解析仓库根 URL", () => {
    expect(githubOwnerRepo("https://github.com/aas-ee/open-websearch"))
      .toEqual({ owner: "aas-ee", repo: "open-websearch" });
  });
  it("解析 tree/blob 路径 URL（忽略后缀）", () => {
    expect(githubOwnerRepo("https://github.com/aas-ee/open-websearch/tree/main/skills/open-websearch"))
      .toEqual({ owner: "aas-ee", repo: "open-websearch" });
    expect(githubOwnerRepo("https://github.com/owner/repo/blob/main/README.md"))
      .toEqual({ owner: "owner", repo: "repo" });
  });
  it("解析 owner/repo 简写", () => {
    expect(githubOwnerRepo("aas-ee/open-websearch"))
      .toEqual({ owner: "aas-ee", repo: "open-websearch" });
  });
  it("非 GitHub 返回 null", () => {
    expect(githubOwnerRepo("https://gitlab.com/x/y")).toBeNull();
    expect(githubOwnerRepo("https://example.com")).toBeNull();
  });
});

describe("parseInstallSource", () => {
  it("GitHub URL → github 类型", () => {
    expect(parseInstallSource("https://github.com/aas-ee/open-websearch"))
      .toEqual({ kind: "github", owner: "aas-ee", repo: "open-websearch" });
  });
  it("owner/repo → github 类型", () => {
    expect(parseInstallSource("aas-ee/open-websearch"))
      .toEqual({ kind: "github", owner: "aas-ee", repo: "open-websearch" });
  });
  it("npm 包名（含 npm: 前缀与裸名）→ npm 类型", () => {
    expect(parseInstallSource("npm:pi-mcp-adapter"))
      .toEqual({ kind: "npm", name: "pi-mcp-adapter" });
    expect(parseInstallSource("pi-mcp-adapter"))
      .toEqual({ kind: "npm", name: "pi-mcp-adapter" });
  });
  it("空输入 → null", () => {
    expect(parseInstallSource("")).toBeNull();
    expect(parseInstallSource("   ")).toBeNull();
  });
});

import { createServer, type Server } from "node:http";

describe("GitHub API 封装", () => {
  let server: Server;
  let base = "";

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.headers["user-agent"] === undefined) {
        res.writeHead(400);
        res.end();
        return;
      }
      const u = new URL(req.url!, base);
      const p = u.pathname;
      if (p.endsWith("/contents/skills")) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify([
          { name: "open-websearch", type: "dir" },
          { name: "find-skills", type: "dir" },
        ]));
        return;
      }
      if (p.endsWith("/contents/skills/open-websearch")) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify([
          { name: "SKILL.md", type: "file" },
          { name: "references", type: "dir" },
        ]));
        return;
      }
      if (p.endsWith("/contents/skills/open-websearch/references")) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify([
          { name: "setup.md", type: "file" },
        ]));
        return;
      }
      if (p.endsWith("/SKILL.md")) {
        res.end("# Open WebSearch\n");
        return;
      }
      if (p.endsWith("/setup.md")) {
        res.end("# Setup\n");
        return;
      }
      if (p.includes("/repos/")) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ default_branch: "main" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    base = `http://127.0.0.1:${(addr as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("githubListDir 返回文件/目录类型", async () => {
    const { githubListDir } = await import("../src/github-source.ts");
    const items = await githubListDir("a", "b", "main", "skills", "", base);
    expect(items.map((i) => i.name)).toEqual(["open-websearch", "find-skills"]);
    expect(items[0].type).toBe("dir");
  });

  it("githubFetchFile 返回内容", async () => {
    const { githubFetchFile } = await import("../src/github-source.ts");
    const text = await githubFetchFile("a", "b", "main", "skills/open-websearch/SKILL.md", "", base);
    expect(text).toContain("# Open WebSearch");
  });

  it("downloadTree 递归收集文件（相对路径键）", async () => {
    const { downloadTree } = await import("../src/github-source.ts");
    const tree = await downloadTree("a", "b", "main", "skills/open-websearch", "", {
      apiBase: base,
      rawBase: base,
    });
    expect(tree.has("SKILL.md")).toBe(true);
    expect(tree.has("references/setup.md")).toBe(true);
  });
});

describe("递归 skill 搜索", () => {
  let server: Server;
  let base = "";

  beforeAll(async () => {
    server = createServer((req, res) => {
      const p = new URL(req.url!, base).pathname;
      // skills/ → 分类目录
      if (p.endsWith("/contents/skills")) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify([{ name: "engineering", type: "dir" }]));
        return;
      }
      // skills/engineering → 含 tdd + code-review（目录）
      if (p.endsWith("/contents/skills/engineering")) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify([
          { name: "tdd", type: "dir" },
          { name: "code-review", type: "dir" },
        ]));
        return;
      }
      // skills/engineering/tdd → 含 SKILL.md
      if (p.endsWith("/contents/skills/engineering/tdd")) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify([{ name: "SKILL.md", type: "file" }]));
        return;
      }
      // skills/engineering/code-review → 含 SKILL.md
      if (p.endsWith("/contents/skills/engineering/code-review")) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify([{ name: "SKILL.md", type: "file" }]));
        return;
      }
      if (p.endsWith("/SKILL.md")) { res.end("# X\n"); return; }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ default_branch: "main" }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("递归发现所有含 SKILL.md 的目录（含分类深层）", async () => {
    const { githubFindSkills } = await import("../src/github-source.ts");
    const found = await githubFindSkills("a", "b", "main", "skills", "", { apiBase: base });
    const paths = found.map((f) => f.path).sort();
    expect(paths).toEqual([
      "skills/engineering/code-review",
      "skills/engineering/tdd",
    ]);
    expect(found.map((f) => f.name).sort()).toEqual(["code-review", "tdd"]);
  });
});
