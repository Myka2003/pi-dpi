# Session 存储模型重构实施计划（稀疏检出 + 按需拉取）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 内容仓库的 sessions/ 永不进入本地工作区——克隆秒级（blob:none + sparse），浏览用 git 元数据，恢复/归档按需操作 git 对象库。

**Architecture:** 复用现有 git 封装（credential/proxy/超时），新增 5 个 git 辅助函数；克隆改 `--filter=blob:none --sparse`；scanArchived 从目录扫描改为 `git ls-tree` 元数据（文件名时间戳排序、名字懒加载）；恢复 `git show`、归档 `hash-object + update-index` 直写。

**Tech Stack:** TypeScript + vitest + git CLI。

## Global Constraints

- 每个 Task 完成后 `tsc --noEmit && npm run test` 全绿再提交（现有 44 测试不允许破坏）
- 共享代码放 `src/`（extensions/ 下每个 .ts 都是 pi 扩展入口）
- git 辅助沿用现有容错模式（失败静默/超时 8s，绝不抛）
- 提交信息 Conventional Commits
- 参考 spec: `docs/superpowers/specs/2026-08-01-session-storage-model-design.md`

---

## 文件结构

```
software/pi-dpi-main/
├── src/
│   ├── git.ts                    # Task 1：+5 个辅助（ls-tree/show/hash-object/update-index/remove）
│   ├── sessions-shared.ts        # Task 3：scanArchived 改元数据；+parseArchivedFromText
│   └── session-picker.ts         # Task 6：列表展示适配
├── extensions/
│   ├── dpi-auth.ts               # Task 2：ensureRepo 稀疏克隆
│   ├── session-browser.ts        # Task 4：restore/rename/delete 改 git 直写
│   └── session-vcs.ts            # Task 5：归档改 hash-object + update-index
└── test/
    ├── git-helpers.test.ts       # Task 1
    └── sessions-meta.test.ts     # Task 3
```

---

## Task 1: git 辅助函数

**Files:**
- Modify: `src/git.ts`
- Test: `test/git-helpers.test.ts`

**Interfaces:**
- Produces（全部 async，opts 复用现有 `GitOptions`）：
  ```typescript
  export interface GitLsEntry { path: string; mode: string; type: string; blob: string; size: number; }
  export async function gitLsTree(repo: string, treeish: string, path: string, opts: GitOptions): Promise<GitLsEntry[]>;
  export async function gitShow(repo: string, treeish: string, path: string, opts: GitOptions): Promise<Buffer>;
  export async function gitHashObject(repo: string, file: string, opts: GitOptions): Promise<string>;
  export async function gitUpdateIndexCacheInfo(repo: string, path: string, blob: string, opts: GitOptions): Promise<void>;
  export async function gitIndexRemove(repo: string, path: string, opts: GitOptions): Promise<void>;
  ```

- [ ] **Step 1: 写失败测试**（`test/git-helpers.test.ts`，用临时 git 仓库）

```typescript
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitLsTree, gitShow, gitHashObject, gitUpdateIndexCacheInfo, gitIndexRemove } from "../src/git.ts";

let repo = "";
let blob: string;

function run(...args: string[]) {
  execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "dpi-git-"));
  run("init", "-b", "main");
  mkdirSync(join(repo, "sessions", "coder"), { recursive: true });
  writeFileSync(join(repo, "sessions/coder/a.jsonl"), '{"type":"session","timestamp":"2026-08-01T00:00:00Z"}\n');
  run("add", "-A");
  run("commit", "-m", "init");
  // 模拟稀疏（工作区删掉 sessions，但 index/tree 保留）
  rmSync(join(repo, "sessions"), { recursive: true });
});

afterAll(() => rmSync(repo, { recursive: true }));

describe("git helpers", () => {
  it("gitLsTree lists session files with size", async () => {
    const entries = await gitLsTree(repo, "HEAD", "sessions", { noAuth: true });
    expect(entries.length).toBe(1);
    expect(entries[0].path).toBe("sessions/coder/a.jsonl");
    expect(entries[0].size).toBeGreaterThan(0);
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd software/pi-dpi-main && npx vitest run test/git-helpers.test.ts`
Expected: FAIL（函数不存在）

- [ ] **Step 3: 实现 src/git.ts 辅助**

在 `gitIn`/`git` 之后追加：

```typescript
export interface GitLsEntry {
  path: string;
  mode: string;
  type: string;
  blob: string;
  size: number;
}

/** git ls-tree -r --long：列 tree 下条目（元数据，不拉 blob） */
export async function gitLsTree(
  repo: string,
  treeish: string,
  path: string,
  opts: GitOptions = {},
): Promise<GitLsEntry[]> {
  const { stdout } = await gitIn(repo, ["ls-tree", "-r", "--long", treeish, "--", path], {
    ...opts,
    timeoutMs: opts.timeoutMs ?? GIT_TIMEOUT,
  });
  const out: GitLsEntry[] = [];
  for (const line of stdout.split("\n")) {
    // 格式: <mode> <type> <blob> <size>\t<path>
    const m = /^(\S+) (\S+) (\S+) (\d+)\t(.+)$/.exec(line);
    if (m) {
      out.push({
        mode: m[1],
        type: m[2],
        blob: m[3],
        size: Number(m[4]),
        path: m[5],
      });
    }
  }
  return out;
}

/** git show <treeish>:<path>：按需拉取 blob（partial clone 下自动 lazy fetch） */
export async function gitShow(
  repo: string,
  treeish: string,
  path: string,
  opts: GitOptions = {},
): Promise<Buffer> {
  const { stdout } = await gitIn(repo, ["show", `${treeish}:${path}`], opts);
  return Buffer.from(stdout);
}

/** git hash-object -w：把文件写入对象库（不触碰工作区/index） */
export async function gitHashObject(
  repo: string,
  file: string,
  opts: GitOptions = {},
): Promise<string> {
  const { stdout } = await gitIn(repo, ["hash-object", "-w", file], opts);
  return stdout.trim();
}

/** git update-index --add --cacheinfo：把 blob 登记进 index（工作区可无此文件） */
export async function gitUpdateIndexCacheInfo(
  repo: string,
  path: string,
  blob: string,
  opts: GitOptions = {},
): Promise<void> {
  await gitIn(repo, ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], opts);
}

/** git update-index --force-remove：从 index 移除路径（工作区可无此文件） */
export async function gitIndexRemove(
  repo: string,
  path: string,
  opts: GitOptions = {},
): Promise<void> {
  await gitIn(repo, ["update-index", "--force-remove", path], opts);
}
```

注意 `gitShow` 的 stdout 为二进制安全：`execFile` 默认返回 Buffer 时 stdout 是 Buffer——确认 `gitIn` 返回的 stdout 类型（若为 string 需改 `run` 的 encoding 或转 Buffer.from(stdout, "binary")）。**实现时先验证 gitIn 的 stdout 类型**（execFile 无 encoding 时 stdout 是 Buffer，但 promisify 默认 utf8 string——需要检查 src/git.ts 的 run 实现）。

- [ ] **Step 4: 运行测试确认通过 + 全量**

Run: `cd software/pi-dpi-main && npx vitest run && tsc --noEmit`
Expected: 48 个测试全绿（44 + 4 新）

- [ ] **Step 5: Commit**

```bash
git add src/git.ts test/git-helpers.test.ts
git commit -m "feat(git): ls-tree/show/hash-object/update-index 辅助（按需会话存取）"
```

---

## Task 2: ensureRepo 稀疏克隆

**Files:**
- Modify: `extensions/dpi-auth.ts`（ensureRepo 函数）
- Test: 无（手动冒烟：`/dpi-agent-login` 新绑定秒级）

**Interfaces:**
- Consumes: Task 1 无（此处只用 gitIn）
- Produces: 新克隆的工作区只含 `agents skills extensions machines docs`（+ 仓库根文件）

- [ ] **Step 1: 改 ensureRepo 的 clone 调用**

找到 `ensureRepo` 中的两条 clone 分支（`["clone", "--branch", "main", repoUrl, repoPath]` 和 `["clone", repoUrl, repoPath]`），改为：

```typescript
await git(["clone", "--filter=blob:none", "--sparse", "--branch", "main", repoUrl, repoPath], {
  ...gitOpts,
  timeoutMs: CLONE_TIMEOUT,
});
// 稀疏检出：只保留运行时配置目录（sessions/ 按需拉取）
try {
  await gitIn(repoPath, ["sparse-checkout", "set", "agents", "skills", "extensions", "machines", "docs"], gitOpts);
} catch {
  // 稀疏设置失败不阻断（退化：全量工作区仍可用）
}
```

退化分支（非 main）同理加 `--filter=blob:none --sparse` 和 sparse-checkout set。

注意：已有本地仓库复用的分支（set-url origin）不动——老仓库保持全量，重装走新流程（spec 已确认）。

- [ ] **Step 2: typecheck + 全量测试**

Run: `cd software/pi-dpi-main && tsc --noEmit && npm run test`
Expected: 全绿

- [ ] **Step 3: Commit**

```bash
git add extensions/dpi-auth.ts
git commit -m "feat(login): 稀疏克隆（blob:none + sparse-checkout，sessions 按需）"
```

---

## Task 3: scanArchived 改 git 元数据

**Files:**
- Modify: `src/sessions-shared.ts`
- Test: `test/sessions-meta.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `gitLsTree`、`gitShow`
- Produces:
  ```typescript
  export interface ArchivedMeta {
    agent: string;         // sessions/ 下子目录名（含 _legacy）
    path: string;          // 仓库相对路径 sessions/<agent>/<file>.jsonl
    fileName: string;
    size: number;          // 字节
    sortKey: number;       // 文件名时间戳（Date.parse 文件名开头 ISO）
    dayLabel: string;      // YYYY-MM-DD
  }
  export async function scanArchivedMeta(repo: string): Promise<ArchivedMeta[]>;
  export async function fetchArchivedName(repo: string, path: string): Promise<string>; // gitShow + 解析最新 session_info
  ```
  （旧 `scanArchived`/`parseArchived` 保留不动——懒加载名字时复用解析逻辑，改为 `parseArchivedFromText(text: string): { name: string; dayLabel: string }`）

- [ ] **Step 1: 写失败测试**（`test/sessions-meta.test.ts`，临时仓库，构造两个会话文件+一个带名字）

```typescript
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanArchivedMeta, fetchArchivedName } from "../src/sessions-shared.ts";

let repo = "";
function run(...args: string[]) { execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" }); }

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "dpi-meta-"));
  run("init", "-b", "main");
  mkdirSync(join(repo, "sessions", "coder"), { recursive: true });
  writeFileSync(join(repo, "sessions/coder/2026-08-01T00-00-00-000Z_a.jsonl"), '{"type":"session","timestamp":"2026-08-01T00:00:00Z"}\n{"type":"session_info","name":"命名会话"}\n');
  writeFileSync(join(repo, "sessions/coder/2026-08-02T00-00-00-000Z_b.jsonl"), '{"type":"session","timestamp":"2026-08-02T00:00:00Z"}\n');
  run("add", "-A");
  run("commit", "-m", "init");
  rmSync(join(repo, "sessions"), { recursive: true }); // 模拟稀疏
});

afterAll(() => rmSync(repo, { recursive: true }));

describe("scanArchivedMeta", () => {
  it("lists sessions from git metadata sorted by filename timestamp desc", async () => {
    const list = await scanArchivedMeta(repo);
    expect(list.length).toBe(2);
    expect(list[0].fileName).toContain("2026-08-02");
    expect(list[0].agent).toBe("coder");
    expect(list[0].size).toBeGreaterThan(0);
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd software/pi-dpi-main && npx vitest run test/sessions-meta.test.ts`
Expected: FAIL（函数不存在）

- [ ] **Step 3: 实现**

在 `src/sessions-shared.ts` 追加（复用 `truncate`/`extractText`/`cleanUserText` 等现有内部函数——把 `parseArchived` 内的名字解析抽出为 `parseNameFromText(text: string): string`）：

```typescript
/** 从 JSONL 文本解析最新 session_info 名字（流式覆盖取最后一条） */
export function parseNameFromText(text: string): string {
  let name = "";
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t) as Record<string, unknown>;
      if (rec.type === "session_info" && typeof rec.name === "string" && rec.name.trim() !== "") {
        name = rec.name.trim();
      }
    } catch {
      // 坏行跳过
    }
  }
  return name;
}

export interface ArchivedMeta {
  agent: string;
  path: string;
  fileName: string;
  size: number;
  sortKey: number;
  dayLabel: string;
}

/** 文件名时间戳：2026-08-01T00-00-00-000Z_<uuid>.jsonl → Date.parse（下划线代替冒号） */
function metaFromFileName(fileName: string): { sortKey: number; dayLabel: string } {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)/.exec(fileName);
  if (!m) return { sortKey: 0, dayLabel: "" };
  const iso = m[1].replace(/-(\d{2}-\d{2}-\d{3}Z)$/, ":$1"); // 00-00-00-000Z → 00:00:00.000Z
  const ts = Date.parse(iso);
  return { sortKey: Number.isNaN(ts) ? 0 : ts, dayLabel: m[1].slice(0, 10) };
}

/** 从 git 元数据列归档（不下载内容） */
export async function scanArchivedMeta(repo: string): Promise<ArchivedMeta[]> {
  try {
    const entries = await gitLsTree(repo, "origin/main", "sessions", { noAuth: true, timeoutMs: 8000 });
    const out: ArchivedMeta[] = [];
    for (const e of entries) {
      const m = /^sessions\/([^/]+)\/([^/]+\.jsonl)$/.exec(e.path);
      if (!m) continue;
      const { sortKey, dayLabel } = metaFromFileName(m[2]);
      out.push({ agent: m[1], path: e.path, fileName: m[2], size: e.size, sortKey, dayLabel });
    }
    return out.sort((a, b) => b.sortKey - a.sortKey);
  } catch {
    return [];
  }
}

/** 懒加载单个归档的名字（git show 拉 blob 解析） */
export async function fetchArchivedName(repo: string, path: string): Promise<string> {
  try {
    const buf = await gitShow(repo, "origin/main", path, { noAuth: true, timeoutMs: 8000 });
    return parseNameFromText(buf.toString("utf-8"));
  } catch {
    return "";
  }
}
```

注意：`gitLsTree` 的 treeish 用 `origin/main`（监听已 fetch；list 打开前由调用方兜底 fetch）。`gitShow` 需要 `gitIn` 的 stdout 是 Buffer——与 Task 1 同一验证点。

- [ ] **Step 4: 运行测试确认通过 + 全量**

Run: `cd software/pi-dpi-main && npx vitest run && tsc --noEmit`
Expected: 52 个测试全绿（48 + 4 新）

- [ ] **Step 5: Commit**

```bash
git add src/sessions-shared.ts test/sessions-meta.test.ts
git commit -m "feat(sessions): scanArchivedMeta 基于 git 元数据 + 名字懒加载"
```

---

## Task 4: session-browser 改 git 直写

**Files:**
- Modify: `extensions/session-browser.ts`

**Interfaces:**
- Consumes: Task 1 的 `gitShow`/`gitUpdateIndexCacheInfo`/`gitIndexRemove`、Task 3 的 `scanArchivedMeta`/`fetchArchivedName`/`ArchivedMeta`
- Produces: /dpi-sessions 的列表/恢复/重命名/删除全部走 git；`ArchivedSession` 接口由 `ArchivedMeta` 替代（picker 展示适配在 Task 6）

- [ ] **Step 1: handler 主流程改造**

`/dpi-sessions` handler：
1. 打开前 `git fetch origin`（兜底最新，复用现有 `gitIn` + token opts——从 `target()` 逻辑取 opts 或直接 `loadConfig` + `gitIn(repo, ["fetch", "origin"], opts)`）
2. `const list = await scanArchivedMeta(repo)`；空列表提示不变
3. 传给 picker 的条目：`id: fileName, label: \`[agent] fileName\`, meta: \`${size}KB\`（或 MB）, data: ArchivedMeta`
4. 选中后**先懒加载名字**：`const name = await fetchArchivedName(repo, meta.path)`——子菜单标题 `会话操作 — name || fileName`
5. 恢复：`gitShow(repo, "origin/main", meta.path)` → 写本机会话目录（现有 restoreArchived 的 cwd 改写逻辑保留，输入从本地文件改为 Buffer）
6. 重命名：`gitShow` 拉内容 → 追加 session_info 行 → `gitHashObject` → `gitUpdateIndexCacheInfo` 同路径 → `git commit -m "rename session"` → `git push`（push 失败静默）；当前会话联动 setSessionName 逻辑保留
7. 删除：`gitIndexRemove` → commit → push

- [ ] **Step 2: typecheck + 全量测试**

Run: `cd software/pi-dpi-main && tsc --noEmit && npm run test`
Expected: 全绿（browser 逻辑无单测，靠冒烟）

- [ ] **Step 3: Commit**

```bash
git add extensions/session-browser.ts
git commit -m "refactor(sessions): 浏览/恢复/重命名/删除走 git 直写"
```

---

## Task 5: session-vcs 归档改 git 直写

**Files:**
- Modify: `extensions/session-vcs.ts`

**Interfaces:**
- Consumes: Task 1 的 `gitHashObject`/`gitUpdateIndexCacheInfo`
- Produces: session_shutdown 归档不落工作区（sessions/ 保持不在工作区）

- [ ] **Step 1: session_shutdown 归档改造**

现有逻辑：`copyFileSync(file, join(dir, basename(file)))` + `commitArchive`（git add -A + commit）。改为：

```typescript
// 归档：直写 git 对象库（sessions/ 不在工作区，不能 copyFileSync + git add）
const relPath = `sessions/${archiveAgentName()}/${basename(file)}`;
const blob = await gitHashObject(cfg.repoPath, file, { noAuth: true, timeoutMs: 8000 });
await gitUpdateIndexCacheInfo(cfg.repoPath, relPath, blob, { noAuth: true, timeoutMs: 8000 });
await gitIn(cfg.repoPath, ["commit", "-m", "[sync] archive session"], { noAuth: true, timeoutMs: 8000 });
// commitArchive 的 add -A 不再需要（工作区没有 sessions）；保留 sweep 由 dpi-sync 负责
```

注意：`commitArchive` 里的 `git add -A` 在稀疏模式下会把工作区其他改动一起提交（agents 等）——**保留**（与 dpi-sync sweep 一致），但**不要**再 copy 文件到工作区。save-state 的 lastArchive 写入保留。

- [ ] **Step 2: typecheck + 全量测试**

Run: `cd software/pi-dpi-main && tsc --noEmit && npm run test`
Expected: 全绿

- [ ] **Step 3: Commit**

```bash
git add extensions/session-vcs.ts
git commit -m "refactor(session-vcs): 归档直写 git（hash-object + update-index）"
```

---

## Task 6: session-picker 展示适配

**Files:**
- Modify: `src/session-picker.ts`

**Interfaces:**
- Consumes: Task 3 的 `ArchivedMeta`
- Produces: 列表项 `[agent] fileName · size`；`showSessionPicker` 签名改为接收 `ArchivedMeta[]`

- [ ] **Step 1: 改造 showSessionPicker**

```typescript
export type SessionPickerResult = ArchivedMeta | "cycle-filter" | undefined;

export function showSessionPicker(
  ctx: ExtensionCommandContext,
  entries: ArchivedMeta[],
  currentAgent: string,
  onlyCurrent: boolean,
): Promise<SessionPickerResult> {
  const items: VimListItem<ArchivedMeta>[] = entries
    .filter((s) => !onlyCurrent || s.agent === currentAgent)
    .map((s) => ({
      id: s.fileName,
      label: `[${s.agent}] ${s.fileName}`,
      meta: s.size >= 1024 * 1024 ? `${(s.size / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(s.size / 1024))}KB`,
      data: s,
    }));
  // ... 其余不变（actions 的 cycle-filter 保留）
}
```

（去掉排序——scanArchivedMeta 已按时间倒序；`entryTitle`/`relTime` 不再用于列表，名字懒加载在 browser 层）

- [ ] **Step 2: typecheck + 全量测试 + 冒烟**

Run: `cd software/pi-dpi-main && tsc --noEmit && npm run test`
Expected: 全绿

- [ ] **Step 3: Commit**

```bash
git add src/session-picker.ts
git commit -m "refactor(session-picker): 列表展示 git 元数据（文件名+大小）"
```

---

## Task 7: 端到端验证

- [ ] **Step 1: 新克隆冒烟**

在临时目录模拟新绑定（稀疏克隆真实内容仓库）：
```bash
git clone --filter=blob:none --sparse <内容仓库> /tmp/sparse-test
git -C /tmp/sparse-test sparse-checkout set agents skills extensions machines docs
du -sh /tmp/sparse-test   # 期望 < 10MB（vs 全量 357MB）
ls /tmp/sparse-test       # 无 sessions/ 目录
git -C /tmp/sparse-test ls-tree -r --long origin/main sessions | head -3   # 元数据可列
git -C /tmp/sparse-test show origin/main:sessions/coder/<某文件> | head -1  # 按需拉 blob
```

- [ ] **Step 2: 函数冒烟（node 直接调用）**

```bash
node --experimental-strip-types --input-type=module -e "
import { scanArchivedMeta, fetchArchivedName } from './src/sessions-shared.ts';
const repo = process.env.HOME + '/.pi/agent/dpi/repo';  // 注意：本地仓库非稀疏，仅验证函数路径
const list = await scanArchivedMeta(repo);
console.log('列表条数:', list.length, '首条:', list[0]?.fileName);
"
```

（若本地仓库是旧全量 clone，`scanArchivedMeta` 用 origin/main 的 git 数据也应工作——验证后如需可临时把本地仓库转稀疏测试，但不必强求）

- [ ] **Step 3: 全量验证 + 发布**

```bash
cd software/pi-dpi-main && tsc --noEmit && npm run test   # 全绿
rsync -az --delete --exclude .git --exclude node_modules ./ ~/.pi/agent/git/github.com/oc101363-creator/pi-dpi/
cd ~/.pi/agent/git/github.com/oc101363-creator/pi-dpi && git add -A && git commit -m "feat(sessions): 稀疏存储模型（按需拉取）" && git push
npm version patch && npm publish --access public --registry=https://registry.npmjs.org
```
