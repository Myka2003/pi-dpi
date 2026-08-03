# Skill/扩展一键安装 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `/dpi-skills` 与 `/dpi-extensions` 支持一键安装——GitHub 链接（自动探测 skill/扩展并下载进内容仓库）与 npm 包名（pi install npm + 仓库记录依赖），安装与声明解耦。

**Architecture:** 新增三个纯逻辑模块（URL/包名解析、GitHub API 封装、skill/扩展安装编排），挂在现有 registry-manager 主循环末尾的固定「+ Add」项上；CLI 化走同一 handler 的 `add <input>` 参数分支。全部用 execFileSync（curl/git/pi）子进程，与项目现有 git.ts/ensureRepoDeps 风格一致。

**Tech Stack:** TypeScript、vitest（测试）、curl 子进程（GitHub API/raw 拉取）、git 子进程（commit/push）、pi CLI（npm 安装）、VimListPicker（skill 多选）。

**Spec:** `docs/superpowers/specs/2026-08-03-skill-extension-install-design.md`

## Global Constraints

- 内容仓库路径来自 `loadConfig().repoPath`；未绑定时 notify「No content repo bound, run /dpi-agent-login first」并 return。
- GitHub 只走公共 API（免认证）；代理复用 `loadConfig().proxy`（如 `http://127.0.0.1:7890`），curl 加 `-x <proxy>`。
- GitHub API 请求必须带 `-H "User-Agent: pi-dpi"`（GitHub 强制）。
- 目录/文件名校验一律 `/^[\w-]+$/` 白名单，防路径穿越。
- 全部容错：任何一步失败 notify 明确错误，绝不抛异常阻断 pi。
- 安装后**不自动声明** agent（解耦）；只 commit + push。
- 只支持 GitHub；不支持 GitLab/Bitbucket。
- 测试在仓库内 `npm install --ignore-scripts --no-save` 后 `npm test` 跑；`/usr/local/bin/tsc --noEmit` 做类型检查。

---

### Task 1: 安装来源解析（纯函数）

**Files:**
- Create: `src/github-source.ts`（本任务只加解析部分，Task 2 加 API 部分）
- Test: `test/github-source.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `export type InstallSource = { kind: "github"; owner: string; repo: string } | { kind: "npm"; name: string }`
  - `export function parseInstallSource(input: string): InstallSource | null`
  - `export function githubOwnerRepo(url: string): { owner: string; repo: string } | null`

- [ ] **Step 1: 写失败测试**

```ts
// test/github-source.test.ts
import { describe, expect, it } from "vitest";
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- --run test/github-source.test.ts`
Expected: FAIL，`Cannot find module '../src/github-source.ts'`

- [ ] **Step 3: 实现**

```ts
// src/github-source.ts
export type InstallSource =
  | { kind: "github"; owner: string; repo: string }
  | { kind: "npm"; name: string };

const GITHUB_URL = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)/i;

/** 从 GitHub URL（任意形态：根/tree/blob/raw）提取 owner/repo；非 GitHub 返回 null */
export function githubOwnerRepo(input: string): { owner: string; repo: string } | null {
  const s = input.trim();
  const m = GITHUB_URL.exec(s);
  if (m) return { owner: m[1], repo: m[2] };
  // owner/repo 简写（不含协议/路径）
  const brief = /^([\w.-]+)\/([\w.-]+)$/.exec(s);
  if (brief && !s.includes("://")) return { owner: brief[1], repo: brief[2] };
  return null;
}

/** 解析安装来源：GitHub URL / owner/repo → github；npm 名（npm: 前缀或裸名）→ npm */
export function parseInstallSource(input: string): InstallSource | null {
  const s = input.trim();
  if (!s) return null;
  const gh = githubOwnerRepo(s);
  if (gh) return { kind: "github", ...gh };
  const npmName = s.startsWith("npm:") ? s.slice(4).trim() : s;
  if (/^[\w@./-]+$/.test(npmName) && !npmName.includes("://")) {
    return { kind: "npm", name: npmName };
  }
  return null;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- --run test/github-source.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: 类型检查 + 提交**

```bash
/usr/local/bin/tsc --noEmit
git add src/github-source.ts test/github-source.test.ts
git commit -m "feat(install): 安装来源解析（GitHub URL / npm 包名）"
```

---

### Task 2: GitHub API 封装（默认分支 / 列目录 / 拉文件 / 递归下载）

**Files:**
- Modify: `src/github-source.ts`（追加 API 部分）
- Test: `test/github-source.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 的 `githubOwnerRepo`；`loadConfig().proxy`（`../src/config.ts`）
- Produces:
  - `export function fetchUrl(url: string, opts?: { proxy?: string; timeoutMs?: number }): string`（curl -fsSL，抛错由调用方兜底）
  - `export async function githubDefaultBranch(owner: string, repo: string, proxy?: string): Promise<string>`（默认 `main`）
  - `export async function githubListDir(owner: string, repo: string, branch: string, path: string, proxy?: string): Promise<{ name: string; type: "file" | "dir" }[]>`
  - `export async function githubFetchFile(owner: string, repo: string, branch: string, path: string, proxy?: string): Promise<string>`
  - `export async function downloadTree(owner: string, repo: string, branch: string, dirPath: string, proxy?: string): Promise<Map<string, string>>`（相对路径 → 内容，递归，含所有文件）

- [ ] **Step 1: 写失败测试（用本地 http server 模拟 GitHub API）**

```ts
// test/github-source.test.ts 追加
import { createServer, type Server } from "node:http";

describe("GitHub API 封装", () => {
  let server: Server;
  let base = "";
  let proxyPassed = false;

  beforeAll(async () => {
    server = createServer((req, res) => {
      // 记录是否带代理无关（curl -x 在子进程参数里，这里只验证 URL 路由与 UA）
      if (req.headers["user-agent"] === undefined) {
        res.writeHead(400); res.end(); return;
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
      if (p.includes("contents/skills/open-websearch")) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify([
          { name: "SKILL.md", type: "file" },
          { name: "references", type: "dir" },
        ]));
        return;
      }
      if (p.endsWith("/SKILL.md")) {
        res.end("# Open WebSearch\n");
        return;
      }
      if (p.includes("references/setup.md")) {
        res.end("# Setup\n");
        return;
      }
      if (p.includes("/repos/")) {
        // default branch
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ default_branch: "main" }));
        return;
      }
      res.writeHead(404); res.end();
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
    const tree = await downloadTree("a", "b", "main", "skills/open-websearch", "", base);
    expect(tree.has("SKILL.md")).toBe(true);
    expect(tree.has("references/setup.md")).toBe(true);
  });
});
```

**关键点**：`githubListDir`/`githubFetchFile`/`downloadTree`/`githubDefaultBranch` 需要支持注入 API base（测试指向本地 server）。签名加**最后一个可选参数 `apiBase = "https://api.github.com"`**，raw 文件用 `https://raw.githubusercontent.com`。为使测试可注入 raw base，`githubFetchFile` 同样加 `rawBase = "https://raw.githubusercontent.com"` 可选参数；`downloadTree` 透传两个 base。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- --run test/github-source.test.ts`
Expected: FAIL，函数未导出（TypeError: not a function）

- [ ] **Step 3: 实现（追加到 github-source.ts）**

```ts
import { execFileSync } from "node:child_process";
import { loadConfig } from "./config.ts";

/** curl 拉取（-fsSL 静默失败即抛错；proxy 为 "" 时不加 -x） */
export function fetchUrl(
  url: string,
  opts: { proxy?: string; timeoutMs?: number } = {},
): string {
  const secs = Math.max(5, Math.round((opts.timeoutMs ?? 30000) / 1000));
  const args = ["-fsSL", "--max-time", String(secs)];
  if (opts.proxy) args.push("-x", opts.proxy);
  args.push(url);
  return execFileSync("curl", args, { encoding: "utf-8" });
}

function proxyOf(): string {
  try {
    return loadConfig().proxy ?? "";
  } catch {
    return "";
  }
}

/** GitHub 默认分支（仓库信息 API）；失败回退 "main" */
export async function githubDefaultBranch(
  owner: string,
  repo: string,
  proxy = proxyOf(),
  apiBase = "https://api.github.com",
): Promise<string> {
  try {
    const out = fetchUrl(
      `${apiBase}/repos/${owner}/${repo}`,
      { proxy },
    );
    const j = JSON.parse(out) as { default_branch?: unknown };
    return typeof j.default_branch === "string" && j.default_branch ? j.default_branch : "main";
  } catch {
    return "main";
  }
}

/** 列 GitHub 目录（contents API）；失败返回 [] */
export async function githubListDir(
  owner: string,
  repo: string,
  branch: string,
  path: string,
  proxy = proxyOf(),
  apiBase = "https://api.github.com",
): Promise<{ name: string; type: "file" | "dir" }[]> {
  try {
    const out = fetchUrl(
      `${apiBase}/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`,
      { proxy },
    );
    const arr = JSON.parse(out) as { name?: unknown; type?: unknown }[];
    return arr
      .filter((e) => typeof e.name === "string" && (e.type === "file" || e.type === "dir"))
      .map((e) => ({ name: e.name as string, type: e.type as "file" | "dir" }));
  } catch {
    return [];
  }
}

/** 拉单个文件（raw）；失败返回 "" */
export async function githubFetchFile(
  owner: string,
  repo: string,
  branch: string,
  path: string,
  proxy = proxyOf(),
  rawBase = "https://raw.githubusercontent.com",
): Promise<string> {
  try {
    return fetchUrl(
      `${rawBase}/${owner}/${repo}/${encodeURIComponent(branch)}/${path}`,
      { proxy },
    );
  } catch {
    return "";
  }
}

/** 递归下载目录下全部文件：相对路径 → 内容（失败的文件跳过） */
export async function downloadTree(
  owner: string,
  repo: string,
  branch: string,
  dirPath: string,
  proxy = proxyOf(),
  opts: { apiBase?: string; rawBase?: string } = {},
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const items = await githubListDir(owner, repo, branch, dirPath, proxy, opts.apiBase);
  for (const it of items) {
    const rel = `${dirPath}/${it.name}`;
    if (it.type === "dir") {
      const sub = await downloadTree(owner, repo, branch, rel, proxy, opts);
      for (const [k, v] of sub) out.set(k, v);
    } else {
      const content = await githubFetchFile(owner, repo, branch, rel, proxy, opts.rawBase);
      if (content !== "") out.set(rel.slice(dirPath.length + 1), content);
    }
  }
  return out;
}
```

**注意**：`githubListDir`/`githubFetchFile`/`githubDefaultBranch`/`downloadTree` 的 `proxy` 参数测试传 `""`（不加 -x），而默认值 `proxyOf()` 取真实代理——测试显式传 `""` 避免真实网络。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- --run test/github-source.test.ts`
Expected: PASS（解析 + API 全部用例）

- [ ] **Step 5: 类型检查 + 提交**

```bash
/usr/local/bin/tsc --noEmit
git add src/github-source.ts test/github-source.test.ts
git commit -m "feat(install): GitHub API 封装（分支/列目录/拉文件/递归下载）"
```

---

### Task 3: 仓库提交推送辅助

**Files:**
- Create: `src/install-common.ts`
- Test: `test/install-common.test.ts`（集成：本地临时 git 仓库）

**Interfaces:**
- Consumes: `gitIn`/`gitAuthOpts`（`../src/git.ts`、`../src/config.ts`）
- Produces:
  - `export async function commitAndPush(repo: string, message: string): Promise<boolean>`（add -A + commit + push；push 失败返回 false 不抛）
  - `export function safeName(name: string): boolean`（`/^[\w-]+$/`）

- [ ] **Step 1: 写失败测试**

```ts
// test/install-common.test.ts
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitAndPush } from "../src/install-common.ts";

let repo = "";
let bare = "";
function run(...args: string[]) { execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" }); }

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "dpi-install-"));
  bare = mkdtempSync(join(tmpdir(), "dpi-install-bare-"));
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  execFileSync("git", ["init", "--bare", "-b", "main", bare], { stdio: "ignore" });
  run("remote", "add", "origin", bare);
  run("config", "user.email", "t@t"); run("config", "user.name", "t");
});

afterAll(() => { rmSync(repo, { recursive: true }); rmSync(bare, { recursive: true }); });

describe("commitAndPush", () => {
  it("提交并推送后远端可见", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(repo, "skills", "x"), { recursive: true });
    writeFileSync(join(repo, "skills/x/SKILL.md"), "# X\n");
    const ok = await commitAndPush(repo, "test: add skill x");
    expect(ok).toBe(true);
    const tree = execFileSync("git", ["-C", bare, "ls-tree", "-r", "--name-only", "main"], { encoding: "utf-8" });
    expect(tree).toContain("skills/x/SKILL.md");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- --run test/install-common.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现**

```ts
// src/install-common.ts
import { gitAuthOpts, loadConfig } from "./config.ts";
import { gitIn } from "./git.ts";

export function safeName(name: string): boolean {
  return /^[\w-]+$/.test(name);
}

/** add -A + commit + push；push 失败（离线/拒绝）返回 false，不抛 */
export async function commitAndPush(repo: string, message: string): Promise<boolean> {
  try {
    await gitIn(repo, ["add", "-A"], { noAuth: true, timeoutMs: 8000 });
    await gitIn(repo, ["commit", "-m", message], { noAuth: true, timeoutMs: 8000 });
  } catch {
    return false; // commit 失败（无变更等）
  }
  try {
    await gitIn(repo, ["push"], gitAuthOpts(15000));
    return true;
  } catch {
    return false; // 已本地提交，push 待补
  }
}

/** 提交消息前缀：内容仓库统一 "[install] " */
export function installCommitMsg(kind: "skill" | "extension", name: string): string {
  return `[install] add ${kind} ${name}`;
}

export { loadConfig };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- --run test/install-common.test.ts`
Expected: PASS

- [ ] **Step 5: 类型检查 + 提交**

```bash
/usr/local/bin/tsc --noEmit
git add src/install-common.ts test/install-common.test.ts
git commit -m "feat(install): 仓库提交推送辅助"
```

---

### Task 4: skill 安装编排

**Files:**
- Create: `src/skill-installer.ts`
- Modify: `src/install-common.ts`（无需改，Task 3 已够）
- Test: `test/skill-installer.test.ts`

**Interfaces:**
- Consumes: `parseInstallSource`/`githubDefaultBranch`/`downloadTree`（github-source.ts）、`commitAndPush`/`safeName`/`installCommitMsg`（install-common.ts）、`ctx.ui`（ExtensionCommandContext）
- Produces:
  - `export async function installSkill(ctx: ExtensionCommandContext, repo: string, input: string): Promise<boolean>`（返回是否成功；已处理 UI 提示）
  - `export async function pickSkillDir(ctx, items: {name:string}[]): Promise<string | null>`（VimListPicker 选择，供测试/复用）

**流程**（handler 内实现）：
1. `parseInstallSource(input)` → 非 github → notify「Expected a GitHub URL」返回 false
2. `githubDefaultBranch(owner, repo)`
3. `githubListDir(owner, repo, branch, "skills")` → 过滤 type=dir 且（可后续校验含 SKILL.md）
4. 空 → notify「No skills/ directory found」返回 false
5. 1 个 → 用之；多个 → VimListPicker 选
6. `downloadTree(owner, repo, branch, `skills/${name}`)` → Map
7. 无 SKILL.md → notify「Not a valid skill (missing SKILL.md)」返回 false
8. 冲突：`skills/${name}` 已存在 → ctx.ui.select 三选一（Overwrite / Skip / Rename）：
   - Skip → notify 返回 true
   - Rename → 追加 `-2`（逐次递增）
   - Overwrite → 继续
9. 写入文件（mkdirSync + writeFileSync），`commitAndPush(repo, installCommitMsg("skill", finalName))`
10. notify 结果（含「用 /dpi-skills 勾选启用」）

- [ ] **Step 1: 写失败测试（本地 server 模拟 + 临时仓库）**

```ts
// test/skill-installer.test.ts
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let server: Server; let apiBase = ""; let rawBase = ""; let repo = ""; let bare = "";
function run(...args: string[]) { execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" }); }

beforeAll(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url!, apiBase);
    const p = u.pathname;
    if (p.includes("/contents/skills")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify([{ name: "open-websearch", type: "dir" }]));
      return;
    }
    if (p.includes("/contents/skills/open-websearch")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify([{ name: "SKILL.md", type: "file" }]));
      return;
    }
    if (p.endsWith("/SKILL.md")) { res.end("---\nname: open-websearch\n---\n# Open WebSearch\n"); return; }
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
  run("config", "user.email", "t@t"); run("config", "user.name", "t");
  mkdirSync(join(repo, "skills"), { recursive: true });
  writeFileSync(join(repo, "skills/.gitkeep"), "");
  run("add", "-A"); run("commit", "-m", "init"); run("push", "-u", "origin", "main");
});
afterAll(() => { server.close(); rmSync(repo, { recursive: true }); rmSync(bare, { recursive: true }); });

// installSkill 通过参数注入 api/raw base 以便测试；handler 层用默认值。
describe("installSkill 落库", () => {
  it("从模拟 GitHub 安装 skill 并提交", async () => {
    const { installSkillWithBase } = await import("../src/skill-installer.ts");
    const fakeCtx = { ui: { notify: () => {}, select: async () => undefined, input: async () => undefined } } as never;
    const ok = await installSkillWithBase(fakeCtx, repo, "aas-ee/open-websearch", { apiBase, rawBase, proxy: "" });
    expect(ok).toBe(true);
    expect(existsSync(join(repo, "skills/open-websearch/SKILL.md"))).toBe(true);
    const tree = execFileSync("git", ["-C", bare, "ls-tree", "-r", "--name-only", "main"], { encoding: "utf-8" });
    expect(tree).toContain("skills/open-websearch/SKILL.md");
  });
});
```

**关键设计**：`installSkill(ctx, repo, input)` 为对外入口（默认 base）；`installSkillWithBase(ctx, repo, input, opts)` 为可注入实现（测试用）。对外入口调用内部实现。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- --run test/skill-installer.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现**

```ts
// src/skill-installer.ts
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  downloadTree,
  githubDefaultBranch,
  githubListDir,
  parseInstallSource,
} from "./github-source.ts";
import { commitAndPush, installCommitMsg, safeName } from "./install-common.ts";
import { showVimListPicker, type VimListItem } from "./vim-list-picker.ts";

export interface InstallOpts {
  apiBase?: string;
  rawBase?: string;
  proxy?: string;
}

/** 多 skill 时用选择器选一个；单个直接返回 */
async function pickSkill(
  ctx: ExtensionCommandContext,
  names: string[],
): Promise<string | null> {
  if (names.length === 1) return names[0];
  const items: VimListItem<string>[] = names.map((n) => ({ id: n, label: n, data: n }));
  const res = await showVimListPicker(ctx, { title: "Select skill", items, mode: "select" });
  if (!res || res.action !== "pick" || !res.item) return null;
  return res.item.data;
}

async function installSkillCore(
  ctx: ExtensionCommandContext,
  repo: string,
  input: string,
  opts: InstallOpts = {},
): Promise<boolean> {
  const src = parseInstallSource(input);
  if (!src || src.kind !== "github") {
    ctx.ui.notify("Expected a GitHub URL (e.g. https://github.com/owner/repo)", "error");
    return false;
  }
  const { owner, repo: rname } = src;
  const branch = await githubDefaultBranch(owner, rname, opts.proxy, opts.apiBase);
  const skills = (await githubListDir(owner, rname, branch, "skills", opts.proxy, opts.apiBase))
    .filter((e) => e.type === "dir" && safeName(e.name))
    .map((e) => e.name);
  if (skills.length === 0) {
    ctx.ui.notify(`No skills/ directory found in ${owner}/${rname}`, "warning");
    return false;
  }
  const skillName = await pickSkill(ctx, skills);
  if (!skillName) return false;
  const tree = await downloadTree(owner, rname, branch, `skills/${skillName}`, opts.proxy, opts);
  if (!tree.has("SKILL.md")) {
    ctx.ui.notify(`${skillName} is not a valid skill (missing SKILL.md)`, "error");
    return false;
  }
  // 名称冲突：覆盖 / 跳过 / 换名
  let finalName = skillName;
  if (existsSync(join(repo, "skills", skillName))) {
    const choice = await ctx.ui.select(`skills/${skillName} already exists`, [
      "Overwrite",
      "Skip",
      "Save as new name",
    ]);
    if (choice === "Skip" || choice === undefined) {
      if (choice === "Skip") ctx.ui.notify(`Skipped ${skillName}`, "info");
      return true;
    }
    if (choice === "Save as new name") {
      let i = 2;
      while (existsSync(join(repo, "skills", `${skillName}-${i}`))) i++;
      finalName = `${skillName}-${i}`;
    }
  }
  const destDir = join(repo, "skills", finalName);
  mkdirSync(destDir, { recursive: true });
  for (const [rel, content] of tree) {
    const full = join(destDir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf-8");
  }
  const pushed = await commitAndPush(repo, installCommitMsg("skill", finalName));
  ctx.ui.notify(
    `Installed ${finalName}${pushed ? "" : " (committed locally, push pending)"} — enable it via /dpi-skills`,
    "info",
  );
  return true;
}

/** 对外入口：installSkill(ctx, repo, input) */
export async function installSkill(
  ctx: ExtensionCommandContext,
  repo: string,
  input: string,
): Promise<boolean> {
  return installSkillCore(ctx, repo, input);
}

/** 测试入口：可注入 api/raw base 与代理 */
export async function installSkillWithBase(
  ctx: ExtensionCommandContext,
  repo: string,
  input: string,
  opts: InstallOpts = {},
): Promise<boolean> {
  return installSkillCore(ctx, repo, input, opts);
}
```

**注意**：`githubDefaultBranch`/`githubListDir`/`downloadTree` 的代理参数：`opts.proxy` 为 `undefined` 时默认取真实代理，测试传 `""` 禁用。`InstallOpts.proxy?: string`——`undefined` 用默认，`""` 禁用。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- --run test/skill-installer.test.ts`
Expected: PASS

- [ ] **Step 5: 类型检查 + 提交**

```bash
/usr/local/bin/tsc --noEmit
git add src/skill-installer.ts test/skill-installer.test.ts
git commit -m "feat(install): skill 安装编排（探测/选择/下载/落库/推送）"
```

---

### Task 5: 扩展安装编排（GitHub + npm）

**Files:**
- Create: `src/extension-installer.ts`
- Test: `test/extension-installer.test.ts`

**Interfaces:**
- Consumes: Task 2/3/4 的辅助；`execFileSync`（node:child_process）执行 `pi install`
- Produces:
  - `export async function installExtension(ctx, repo, input): Promise<boolean>`（对外；GitHub 或 npm 分支）
  - `export async function installExtensionWithBase(ctx, repo, input, opts): Promise<boolean>`（可注入，测试）
  - `export function piInstallNpm(name: string): { ok: boolean; error?: string }`（execFileSync `pi install npm:<name>`；失败捕获返回 ok=false）

**GitHub 分支**（复用 skill 流程骨架）：
1. 探测 `extensions/`：顶层 `*.ts`（file）或目录型（dir 且含 `index.ts`）
2. 多个 → 选择；单个 → 直接
3. 下载：单文件 → `githubFetchFile`；目录型 → `downloadTree`
4. 落点 `Agent/extensions/<name>.ts` 或 `Agent/extensions/<name>/`（保留结构）
5. 冲突处理同 skill（Overwrite / Skip / Rename）
6. commit + push

**npm 分支**：
1. `piInstallNpm(name)`：`execFileSync("pi", ["install", `npm:${name}`])`
2. 失败 → notify 错误返回 false
3. 仓库记录依赖：在 `Agent/package.json` 的 `dependencies` 加 `"<name>": "*"`（已有则跳过；无 package.json 则创建）——跨机器 `ensureRepoDeps` 会 npm install
4. commit + push

- [ ] **Step 1: 写失败测试**

```ts
// test/extension-installer.test.ts
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("piInstallNpm 调用", () => {
  it("pi 缺失时返回 ok=false 而非抛错", () => {
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
      const pkg = JSON.parse(require("node:fs").readFileSync(join(repo, "package.json"), "utf-8"));
      expect(pkg.dependencies["pi-mcp-adapter"]).toBe("*");
      const tree = execFileSync("git", ["-C", bare, "ls-tree", "-r", "--name-only", "main"], { encoding: "utf-8" });
      expect(tree).toContain("package.json");
    } finally {
      rmSync(repo, { recursive: true }); rmSync(bare, { recursive: true });
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- --run test/extension-installer.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现**

```ts
// src/extension-installer.ts
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  downloadTree,
  githubDefaultBranch,
  githubFetchFile,
  githubListDir,
  parseInstallSource,
} from "./github-source.ts";
import { commitAndPush, installCommitMsg, safeName } from "./install-common.ts";
import type { InstallOpts } from "./skill-installer.ts";
import { showVimListPicker, type VimListItem } from "./vim-list-picker.ts";

/** 执行 pi install npm:<name>；失败捕获返回 {ok:false,error} */
export function piInstallNpm(name: string): { ok: boolean; error?: string } {
  try {
    execFileSync("pi", ["install", `npm:${name}`], { stdio: "ignore", timeout: 120000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 在 Agent/package.json 的 dependencies 记录 npm 包（幂等） */
export function recordNpmDependency(repo: string, name: string): void {
  const pkgPath = join(repo, "package.json");
  let pkg: Record<string, unknown>;
  try {
    pkg = existsSync(pkgPath)
      ? (JSON.parse(readFileSync(pkgPath, "utf-8")) as Record<string, unknown>)
      : {};
  } catch {
    pkg = {};
  }
  const deps = (pkg.dependencies as Record<string, string> | undefined) ?? {};
  if (deps[name]) return;
  deps[name] = "*";
  pkg.dependencies = deps;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
}

async function pickOne(ctx: ExtensionCommandContext, names: string[], title: string): Promise<string | null> {
  if (names.length === 1) return names[0];
  const items: VimListItem<string>[] = names.map((n) => ({ id: n, label: n, data: n }));
  const res = await showVimListPicker(ctx, { title, items, mode: "select" });
  if (!res || res.action !== "pick" || !res.item) return null;
  return res.item.data;
}

async function installFromGithub(
  ctx: ExtensionCommandContext,
  repo: string,
  owner: string,
  rname: string,
  opts: InstallOpts,
): Promise<boolean> {
  const branch = await githubDefaultBranch(owner, rname, opts.proxy, opts.apiBase);
  const entries = (await githubListDir(owner, rname, branch, "extensions", opts.proxy, opts.apiBase))
    .filter((e) => safeName(e.name.replace(/\.ts$/, "")));
  const singleFiles = entries.filter((e) => e.type === "file" && e.name.endsWith(".ts")).map((e) => e.name);
  const dirs = entries.filter((e) => e.type === "dir").map((e) => e.name);
  if (singleFiles.length === 0 && dirs.length === 0) {
    ctx.ui.notify(`No extensions/ directory found in ${owner}/${rname}`, "warning");
    return false;
  }
  const all = [...singleFiles, ...dirs];
  const chosen = await pickOne(ctx, all, "Select extension");
  if (!chosen) return false;
  const base = chosen.replace(/\.ts$/, "");
  // 冲突处理
  let finalBase = base;
  if (existsSync(join(repo, "extensions", chosen)) || existsSync(join(repo, "extensions", base))) {
    const choice = await ctx.ui.select(`extensions/${base} already exists`, [
      "Overwrite", "Skip", "Save as new name",
    ]);
    if (choice === "Skip" || choice === undefined) {
      if (choice === "Skip") ctx.ui.notify(`Skipped ${base}`, "info");
      return true;
    }
    if (choice === "Save as new name") {
      let i = 2;
      while (existsSync(join(repo, "extensions", `${base}-${i}`)) || existsSync(join(repo, "extensions", `${base}-${i}.ts`))) i++;
      finalBase = `${base}-${i}`;
    }
  }
  if (singleFiles.includes(chosen)) {
    const content = await githubFetchFile(owner, rname, branch, `extensions/${chosen}`, opts.proxy, opts.rawBase);
    if (!content) { ctx.ui.notify(`Failed to fetch extensions/${chosen}`, "error"); return false; }
    writeFileSync(join(repo, "extensions", `${finalBase}.ts`), content, "utf-8");
  } else {
    const tree = await downloadTree(owner, rname, branch, `extensions/${chosen}`, opts.proxy, opts);
    const destDir = join(repo, "extensions", finalBase);
    mkdirSync(destDir, { recursive: true });
    for (const [rel, content] of tree) {
      const full = join(destDir, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content, "utf-8");
    }
  }
  const pushed = await commitAndPush(repo, installCommitMsg("extension", finalBase));
  ctx.ui.notify(
    `Installed extension ${finalBase}${pushed ? "" : " (committed locally, push pending)"} — enable it via /dpi-extensions`,
    "info",
  );
  return true;
}

async function installExtensionCore(
  ctx: ExtensionCommandContext,
  repo: string,
  input: string,
  opts: InstallOpts = {},
): Promise<boolean> {
  const src = parseInstallSource(input);
  if (!src) { ctx.ui.notify("Invalid input: GitHub URL or npm package name", "error"); return false; }
  if (src.kind === "github") {
    return installFromGithub(ctx, repo, src.owner, src.repo, opts);
  }
  const r = piInstallNpm(src.name);
  if (!r.ok) {
    ctx.ui.notify(`pi install failed: ${r.error ?? "unknown error"}`, "error");
    return false;
  }
  recordNpmDependency(repo, src.name);
  const pushed = await commitAndPush(repo, installCommitMsg("extension", src.name));
  ctx.ui.notify(`Installed npm extension ${src.name}${pushed ? "" : " (recorded locally, push pending)"}`, "info");
  return true;
}

export async function installExtension(ctx: ExtensionCommandContext, repo: string, input: string): Promise<boolean> {
  return installExtensionCore(ctx, repo, input);
}
export async function installExtensionWithBase(ctx: ExtensionCommandContext, repo: string, input: string, opts: InstallOpts = {}): Promise<boolean> {
  return installExtensionCore(ctx, repo, input, opts);
}
```

**注意**：Task 5 的 GitHub 分支测试需要 mock `piInstallNpm`/真实网络，本任务测试聚焦 npm 分支（`recordNpmDependency`）+ `piInstallNpm` 容错；GitHub 分支复用 Task 4 已验证的辅助，靠手动冒烟（Task 7）覆盖。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- --run test/extension-installer.test.ts`
Expected: PASS

- [ ] **Step 5: 类型检查 + 提交**

```bash
/usr/local/bin/tsc --noEmit
git add src/extension-installer.ts test/extension-installer.test.ts
git commit -m "feat(install): 扩展安装编排（GitHub + npm 分支）"
```

---

### Task 6: 注册表入口「+ Add」+ CLI 化

**Files:**
- Modify: `src/registry-manager.ts`（RegistryManagerConfig 加 `addEntry`；主循环列表末尾固定项 + handler）
- Modify: `extensions/skill-manager.ts`（加 addEntry：installSkill）
- Modify: `extensions/ext-manager.ts`（加 addEntry：installExtension）
- Modify: `src/skill-installer.ts` / `src/extension-installer.ts`（无需改）

**Interfaces:**
- Consumes: Task 4/5 的 `installSkill`/`installExtension`；`loadConfig()`（config.ts）
- Produces:
  - `RegistryManagerConfig.addEntry?: { label: string; handler(ctx: ExtensionCommandContext, repo: string, input: string): Promise<boolean> }`
  - `/dpi-skills add <input>`、`/dpi-extensions add <input>` CLI 分支（在各自 handler 开头解析 `add ` 前缀）

- [ ] **Step 1: 修改 registry-manager 支持 addEntry**

```ts
// src/registry-manager.ts —— RegistryManagerConfig 加字段
export interface RegistryManagerConfig {
  kindLabel: string;
  declaredField: "skills" | "extensions";
  scanRegistry(repo: string): RegistryEntry[];
  readDeclared(repo: string, agent: string): string[];
  writeDeclared(repo: string, agent: string, names: string[]): boolean;
  deletePath(repo: string, name: string): void;
  companion?: { ... };
  /** 列表末尾「+ Add」入口；handler 返回 true 表示安装了东西（重开列表） */
  addEntry?: {
    label: string;
    handler(ctx: ExtensionCommandContext, repo: string, input: string): Promise<boolean>;
  };
}
```

主循环里，`items` 数组末尾追加固定项（仅当 `rc.addEntry` 存在）：

```ts
const addItem: VimListItem<RegistryEntry> | null = rc.addEntry
  ? { id: "__add__", label: `+ ${rc.addEntry.label}`, data: { name: "__add__", description: "" } }
  : null;
const items: VimListItem<RegistryEntry>[] = [
  ...registry.map((e) => ({ ... })),
  ...(addItem ? [addItem] : []),
];
```

`res.action === "pick"` 分支处理：若 `res.item.data.name === "__add__"`：

```ts
if (res.action === "pick" && res.item?.data.name === "__add__" && rc.addEntry) {
  const input = (await ctx.ui.input(`${rc.addEntry.label} (GitHub URL or npm package)`, "")) ?? "";
  if (input.trim()) {
    const done = await rc.addEntry.handler(ctx, repo, input.trim());
    if (done) continue; // 重开列表（注册表已变化）
  }
  continue;
}
```

（toggle 模式下 "pick" 不产生——VimListPicker toggle 模式 Enter/Space 是 toggleCurrent。**需要处理**：VimListPicker toggle 模式无法「pick」一个项目。因此 `+ Add` 项在 toggle 列表里需要特殊键或改为 select 首项？）

**方案**：VimListPicker 已有 actions 机制（`d` 删除）。给 `+ Add` 项用**专用动作键 `a`**：`actions: [{key:"d",id:"delete"},{key:"a",id:"add"}]`，VimListPicker 的 action 触发时 `finish(action.id)` 返回当前光标项。registry-manager 处理 `res.action === "add"`：

```ts
const items = [ ...registry items, ...(addItem ? [addItem] : []) ];
const res = await showVimListPicker(ctx, {
  title, items, mode: "toggle",
  actions: [
    { key: "d", id: "delete", hint: "d delete" },
    ...(rc.addEntry ? [{ key: "a", id: "add", hint: "a add" }] : []),
  ],
});
if (res.action === "add") {
  // 光标停在「+ Add」项（用户先移过去再按 a），或任意位置按 a 都触发 add
  const input = (await ctx.ui.input(`${rc.addEntry.label} — GitHub URL or npm package`, "")) ?? "";
  if (input.trim()) {
    if (await rc.addEntry.handler(ctx, repo, input.trim())) continue;
  }
  continue;
}
```

- [ ] **Step 2: skill-manager 接入 addEntry**

```ts
// extensions/skill-manager.ts —— config 加 addEntry
import { installSkill } from "../src/skill-installer.ts";

const config: RegistryManagerConfig = {
  ...existing,
  addEntry: {
    label: "Add skill from GitHub",
    handler: async (ctx, repo, input) => installSkill(ctx, repo, input),
  },
};
```

- [ ] **Step 3: ext-manager 接入 addEntry**

```ts
// extensions/ext-manager.ts
import { installExtension } from "../src/extension-installer.ts";

const config: RegistryManagerConfig = {
  ...existing,
  addEntry: {
    label: "Add extension (GitHub / npm)",
    handler: async (ctx, repo, input) => installExtension(ctx, repo, input),
  },
};
```

- [ ] **Step 4: CLI 化（两个 handler 开头）**

```ts
// extensions/skill-manager.ts handler
handler: async (args, ctx) => {
  const a = (args ?? "").trim();
  if (a.startsWith("add ")) {
    const cfg = loadConfig();
    if (!cfg.repoUrl) { ctx.ui.notify("No content repo bound, run /dpi-agent-login first", "warning"); return; }
    await installSkill(ctx, cfg.repoPath, a.slice(4).trim());
    return;
  }
  await runRegistryManager(ctx, config);
},
```

ext-manager 同构（`add ` → `installExtension`）。

- [ ] **Step 5: 类型检查 + 全量测试 + 提交**

```bash
/usr/local/bin/tsc --noEmit
npm test
git add src/registry-manager.ts extensions/skill-manager.ts extensions/ext-manager.ts
git commit -m "feat(install): /dpi-skills 与 /dpi-extensions 一键安装入口（UI + CLI）"
```

---

### Task 7: 端到端冒烟 + 发布

**Files:**
- Modify: `package.json`（版本 bump 0.8.30）
- Modify: `CHANGELOG.md`（记录）
- Modify: `docs/superpowers/specs/2026-08-03-skill-extension-install-design.md`（无需改）

**Interfaces:**
- Consumes: 全部 Task 1-6

- [ ] **Step 1: 全量验证**

```bash
npm install --ignore-scripts --no-save
/usr/local/bin/tsc --noEmit
npm test
# 预期：11+ 个测试文件，70+ 用例全绿
```

- [ ] **Step 2: 手动冒烟（本机内容仓库）**

```bash
# skill：装 find-skills（真实 GitHub）
pi -c '/dpi-skills add https://github.com/vercel-labs/skills'   # 或交互 UI 里选「+ Add」
# 预期：skills/find-skills/SKILL.md 入库 + push + notify

# skill 多选：装 vercel-labs/skills（仓库有多个 skill，应弹选择器）
pi -c '/dpi-skills add https://github.com/vercel-labs/skills'

# 扩展 npm：装 pi-mcp-adapter
pi -c '/dpi-extensions add pi-mcp-adapter'
# 预期：pi install 执行 + Agent/package.json 记录 + push

# 扩展 GitHub：找一个含 extensions/ 的仓库冒烟
pi -c '/dpi-extensions add https://github.com/owner/repo-with-extensions'
```

- [ ] **Step 3: bump 版本 + CHANGELOG**

```bash
# package.json version → 0.8.30
# CHANGELOG.md 顶部加：
## [0.8.30] - 2026-08-03
### Added
- /dpi-skills 与 /dpi-extensions 一键安装：GitHub 链接自动探测 skill/扩展并入库推送（安装与声明解耦）
- /dpi-extensions 支持 npm 包名（pi install npm + 仓库 package.json 依赖记录，跨机器同步）
- CLI 化：/dpi-skills add <url>、/dpi-extensions add <url|pkg>
```

- [ ] **Step 4: 提交 + 推送 + npm 发布 + 两台机器更新**

```bash
git add -A
git commit -m "chore(release): 0.8.30 — skill/扩展一键安装"
git tag v0.8.30
git -c http.proxy=http://127.0.0.1:7890 -c credential.helper= -c 'credential.helper=!f() { echo username=x-access-token; echo "password=$(cat /Users/mingkaichen/.pi/agent/dpi/token)"; }; f' push https://github.com/Myka2003/pi-dpi.git main --tags
npm publish --access public --registry=https://registry.npmjs.org
# ser7 / x360：
# ssh riff@100.102.192.34 'pi update --extensions'
# ssh riff@100.68.203.92 'pi update --extensions'
```

---

## Self-Review

**Spec coverage：**
- 入口（UI + CLI）→ Task 6
- skill GitHub 安装链路 → Task 4
- 扩展 GitHub + npm 链路 → Task 5
- URL/包名解析 → Task 1
- GitHub API 封装（探测/下载/分支）→ Task 2
- commit+push（认证/代理）→ Task 3
- 错误处理（无效链接/无目录/冲突三选一）→ Task 4/5 内联
- 测试（单测 + 集成 + 手动冒烟）→ Task 1-5 测试 + Task 7
- 范围外（不自动声明/仅 GitHub/无更新卸载）→ 计划未实现，符合 spec

**占位符扫描：** 无 TBD/TODO；所有代码步骤含完整实现。

**类型一致性：** `InstallSource`/`InstallOpts`/`RegistryManagerConfig.addEntry` 跨任务签名一致；`installSkillWithBase`/`installExtensionWithBase` 测试入口与对外入口参数对齐。
