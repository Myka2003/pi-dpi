# pi-dpi 开放级改造实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 pi-dpi 达到可对外开放（开源发布）的成熟度——补齐新用户上手路径（示例内容仓库 + bootstrap）、工程化基础（peerDependencies、CI、CHANGELOG）与社区文档（英文 README、CONTRIBUTING、npm 发布就绪）。

**Architecture:** 在现有 pi-dpi 仓库内增量改造：新增 `templates/content-repo/` 示例仓库与 bootstrap 初始化逻辑（绑定 local 远端时自动创建最小结构）；package.json 补齐 peerDependencies；GitHub Actions 跑 typecheck + vitest；CHANGELOG/英文 README/CONTRIBUTING 补齐；npm 发布只做就绪清单（不实际发布）。

**Tech Stack:** TypeScript + vitest + GitHub Actions + npm。

## Global Constraints

- 每个 Task 完成后必须 `tsc --noEmit && npm run test` 全绿再提交（现有 42 个测试不允许破坏）
- 提交信息遵循 Conventional Commits（`feat:` / `docs:` / `chore:` / `build:`）
- 共享代码放 `src/`（extensions/ 下每个 .ts 都是扩展入口，无 default 导出会报加载错误）
- 不引入新的运行时依赖（零新增 dependencies；peerDependencies 仅声明）
- UI 文案英文，代码注释保留中文（项目既有约定）

---

## 文件结构

```
software/pi-dpi-main/
├── package.json                        # Task 1/7：peerDependencies、版本、files、exports
├── src/
│   └── bootstrap.ts                    # Task 3：内容仓库 bootstrap（创建最小结构）
├── extensions/
│   └── dpi-auth.ts                     # Task 3：local 绑定分支调用 bootstrap
├── templates/
│   └── content-repo/                   # Task 2：示例内容仓库（可 fork）
│       ├── README.md
│       ├── package.json
│       ├── agents/coder/SYSTEM.md
│       ├── agents/coder/agent.json
│       ├── skills/.gitkeep
│       ├── extensions/.gitkeep
│       ├── machines/.gitkeep
│       ├── memory/.gitkeep
│       └── sessions/.gitkeep
├── .github/
│   ├── workflows/ci.yml                # Task 4
│   ├── ISSUE_TEMPLATE/bug_report.md    # Task 8
│   ├── ISSUE_TEMPLATE/feature_request.md # Task 8
│   └── PULL_REQUEST_TEMPLATE.md        # Task 8
├── CHANGELOG.md                        # Task 5
├── README.en.md                        # Task 6
├── CONTRIBUTING.md                     # Task 8
├── docs/
│   └── npm-publish-checklist.md        # Task 7
└── test/
    └── bootstrap.test.ts               # Task 3
```

---

## Task 1: peerDependencies 与 package.json 基础信息

**Files:**
- Modify: `package.json`

**Interfaces:**
- Produces: `package.json` 的 `peerDependencies`、`engines`、`files`、`exports` 字段；后续 Task 7（npm 发布）依赖此结构

- [ ] **Step 1: 查看当前 package.json 并决定最低 pi 版本**

现有 extensions 用到的 API：`agent_settled`（无，pi-goal 用）、`ctx.ui.custom`（vim picker）、`resources_discover`、`pi.sendUserMessage`、`ctx.ui.select/confirm/input/notify`。其中 `agent_settled` 在 pi ≥ 0.80.6 才引入（pi-goal 的 README 明确），`ctx.ui.custom` 与 `resources_discover` 在 0.80.x 稳定。**最低版本取 `>=0.80.6`**（覆盖 agent_settled，也覆盖我们用的全部 API）。

- [ ] **Step 2: 修改 package.json**

在 `package.json` 的 `pi` 字段前插入：

```json
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": ">=0.80.6",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  },
  "engines": {
    "node": ">=20"
  },
```

确认 `files` 字段保持 `["extensions", "src", "templates", "README.md", "README.en.md", "CHANGELOG.md"]`（后三项 Task 2/5/6 加入后再验证）。

- [ ] **Step 3: 验证 typecheck 与测试不受影响**

Run: `cd software/pi-dpi-main && tsc --noEmit && npm run test`
Expected: 全绿（42 个测试通过；package.json 改动不影响代码）

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "build: declare peerDependencies (pi >= 0.80.6) and node >= 20"
```

---

## Task 2: 示例内容仓库模板（templates/content-repo/）

**Files:**
- Create: `templates/content-repo/README.md`、`templates/content-repo/package.json`、`templates/content-repo/agents/coder/SYSTEM.md`、`templates/content-repo/agents/coder/agent.json`、各 `.gitkeep`

**Interfaces:**
- Produces: 可 fork/复制的最小内容仓库结构；Task 3 的 bootstrap 逻辑与其结构一致

- [ ] **Step 1: 创建目录骨架**

```bash
cd software/pi-dpi-main
mkdir -p templates/content-repo/agents/coder templates/content-repo/{skills,extensions,machines,memory,sessions,docs/plans}
touch templates/content-repo/skills/.gitkeep templates/content-repo/extensions/.gitkeep templates/content-repo/machines/.gitkeep templates/content-repo/memory/.gitkeep templates/content-repo/sessions/.gitkeep
```

- [ ] **Step 2: 创建 templates/content-repo/package.json**

```json
{
  "name": "my-agent-world",
  "version": "0.1.0",
  "private": true,
  "description": "My dpi content repo: agents + skills registry + extensions registry",
  "keywords": ["pi-package", "dpi-content-pack"],
  "license": "MIT",
  "pi": {
    "prompts": ["agents/*/prompts"],
    "themes": ["themes"],
    "extensions": ["extensions"]
  }
}
```

- [ ] **Step 3: 创建 agents/coder/SYSTEM.md（示例人格）**

```markdown
# Coder Agent

You are a pragmatic full-stack engineer. Direct, no fluff.

## Principles
- Read code before concluding; never guess at non-existent implementations
- Minimal changes; don't refactor unrelated code
- Explain dangerous operations (delete files, change config, install deps) before executing
- Answer in English; keep code and identifiers in English

## Work style
- Run tests or type checks after substantive changes
```

- [ ] **Step 4: 创建 agents/coder/agent.json（示例声明）**

```json
{
  "description": "Full-stack engineer: writes code, runs commands",
  "skills": [],
  "extensions": []
}
```

- [ ] **Step 5: 创建 templates/content-repo/README.md**

```markdown
# My Agent World (dpi content repo)

This is a starter content repository for [pi-dpi](https://github.com/oc101363-creator/pi-dpi).
Fork or copy this repo (keep it **private** — it will hold your session archives),
then bind it in pi:

```
/dpi-agent-login <your-fork-url>
```

## Structure

| Path | Purpose |
| --- | --- |
| `agents/<name>/SYSTEM.md` | Agent persona (injected into system prompt every turn) |
| `agents/<name>/agent.json` | Capability declaration: `{ description, skills, extensions }` |
| `agents/<name>/prompts/` | Agent-specific prompt templates (`xxx.md` → `/xxx`) |
| `skills/` | Skill registry (flat `<name>/SKILL.md` entries) |
| `extensions/` | Extension registry (flat `<name>.ts` or `<name>/index.ts` directories) |
| `machines/<hostname>.json` | Per-machine overrides (proxy, recordSessions) |
| `memory/<agent>/*.md` | Long-term memory (deprecated, see docs) |
| `sessions/<agent>/` | Session archives by agent |

## Add an agent

Create `agents/<name>/SYSTEM.md` and `agent.json`, declare skills/extensions from the
registries, push — syncs to all your machines automatically.

## Add a skill

Create `skills/<name>/SKILL.md`, then enable it with `/dpi-skills` (writes back to agent.json).

## Add an extension

Create `extensions/<name>.ts` (or `extensions/<name>/index.ts` for multi-file), then enable
with `/dpi-extensions`.
```

- [ ] **Step 6: Commit**

```bash
git add templates/
git commit -m "feat(templates): add forkable content-repo starter"
```

---

## Task 3: /dpi-agent-login 本地仓库自动初始化（bootstrap）

**Files:**
- Create: `src/bootstrap.ts`
- Modify: `extensions/dpi-auth.ts`（local 绑定分支）
- Test: `test/bootstrap.test.ts`

**Interfaces:**
- Consumes: `src/config.ts` 的 `defaultConfig().repoPath`（绑定目标路径）、`scanAgents`
- Produces: `export function ensureContentRepo(repoPath: string): { created: boolean }`——在 repoPath 创建最小内容仓库结构（agents/coder/SYSTEM.md + agent.json + 目录骨架），已存在则不动作（幂等）

- [ ] **Step 1: 写失败测试**

`test/bootstrap.test.ts`：

```typescript
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureContentRepo } from "../src/bootstrap.ts";

describe("ensureContentRepo bootstrap", () => {
  it("creates minimal structure in an empty dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "dpi-test-"));
    const result = ensureContentRepo(dir);
    expect(result.created).toBe(true);
    expect(existsSync(join(dir, "agents/coder/SYSTEM.md"))).toBe(true);
    expect(existsSync(join(dir, "agents/coder/agent.json"))).toBe(true);
    expect(existsSync(join(dir, "skills"))).toBe(true);
    expect(existsSync(join(dir, "extensions"))).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it("is idempotent (no overwrite when structure exists)", () => {
    const dir = mkdtempSync(join(tmpdir(), "dpi-test-"));
    ensureContentRepo(dir);
    const custom = "# my custom persona\n";
    writeFileSync(join(dir, "agents/coder/SYSTEM.md"), custom);
    const result = ensureContentRepo(dir);
    expect(result.created).toBe(false);
    expect(readFileSync(join(dir, "agents/coder/SYSTEM.md"), "utf-8")).toBe(custom);
    rmSync(dir, { recursive: true });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd software/pi-dpi-main && npx vitest run test/bootstrap.test.ts`
Expected: FAIL（bootstrap.ts 不存在）

- [ ] **Step 3: 实现 src/bootstrap.ts**

```typescript
/**
 * bootstrap：内容仓库最小结构初始化（/dpi-agent-login 绑定本地路径时用）。
 * 目录不存在或缺少 agents/ 时自动创建 agents/coder/SYSTEM.md + agent.json
 * 与注册表骨架；已存在结构则不动作（幂等）。
 * 本文件不放 extensions/（pi 会把每个 .ts 当扩展入口）。
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_SYSTEM_MD = `# Coder Agent

You are a pragmatic full-stack engineer. Direct, no fluff.

## Principles
- Read code before concluding; never guess at non-existent implementations
- Minimal changes; don't refactor unrelated code
- Answer in English; keep code and identifiers in English
`;

const DEFAULT_AGENT_JSON = {
  description: "Full-stack engineer: writes code, runs commands",
  skills: [],
  extensions: [],
};

const SKEL_DIRS = ["skills", "extensions", "machines", "memory", "sessions"];

export function ensureContentRepo(repoPath: string): { created: boolean } {
  try {
    if (existsSync(join(repoPath, "agents", "coder", "SYSTEM.md"))) {
      return { created: false };
    }
    mkdirSync(join(repoPath, "agents", "coder"), { recursive: true });
    for (const d of SKEL_DIRS) mkdirSync(join(repoPath, d), { recursive: true });
    writeFileSync(join(repoPath, "agents", "coder", "SYSTEM.md"), DEFAULT_SYSTEM_MD);
    writeFileSync(
      join(repoPath, "agents", "coder", "agent.json"),
      `${JSON.stringify(DEFAULT_AGENT_JSON, null, 2)}\n`,
    );
    return { created: true };
  } catch {
    return { created: false };
  }
}
```

- [ ] **Step 4: 在 dpi-auth.ts 的 local 绑定分支调用 bootstrap**

找到 `login()` 中 local 类型的处理（`if (kind === "ssh" || kind === "local")` 块内的 local 路径存在性检查后），在克隆/校验之前插入：

```typescript
    // local 绑定：目标目录不存在/无 agents/ 时自动初始化最小内容仓库
    if (kind === "local") {
      const { created } = ensureContentRepo(repoPath);
      if (created) {
        ctx.ui.notify(`Initialized minimal content repo at ${repoPath}`, "info");
      }
    }
```

（`ensureContentRepo` 从 `../src/bootstrap.ts` import）

- [ ] **Step 5: 运行测试确认通过 + 全量测试**

Run: `cd software/pi-dpi-main && npx vitest run && tsc --noEmit`
Expected: 44 个测试全绿（原 42 + 新 2）

- [ ] **Step 6: Commit**

```bash
git add src/bootstrap.ts extensions/dpi-auth.ts test/bootstrap.test.ts
git commit -m "feat(login): bootstrap minimal content repo on local bind"
```

---

## Task 4: GitHub Actions CI

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: Task 1 的 package.json（typecheck/test 脚本）
- Produces: push/PR 自动运行 typecheck + vitest

- [ ] **Step 1: 创建 .github/workflows/ci.yml**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npx tsc --noEmit
      - run: npm run test
```

- [ ] **Step 2: 本地验证 CI 命令可跑**

Run: `cd software/pi-dpi-main && npm ci && npx tsc --noEmit && npm run test`
Expected: 全绿

- [ ] **Step 3: Commit 并推送验证 CI 触发**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: GitHub Actions typecheck + vitest"
git push origin main
```

推送后在 GitHub Actions 页确认 workflow 运行通过。

---

## Task 5: CHANGELOG.md

**Files:**
- Create: `CHANGELOG.md`

**Interfaces:**
- Produces: Keep a Changelog 格式的发布记录；npm 发布时随包分发

- [ ] **Step 1: 创建 CHANGELOG.md**

按 [Keep a Changelog](https://keepachangelog.com/) 格式，回填 0.7.0 版本变更（从 git log 提取关键提交）：

```markdown
# Changelog

All notable changes to pi-dpi will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added
- Forkable content-repo template (`templates/content-repo/`) and local-bind bootstrap
- GitHub Actions CI (typecheck + vitest)

## [0.7.0] - 2026-08-01

### Added
- /dpi- prefixed commands (replaces legacy aliases); sessions rename; vim-style list picker with laptop-friendly keys (^D/^U, ^F/^B)
- Remote watch (3s fetch loop) with auto-pull and live Sync status in agent card
- Save-state visibility (archive/push status, pending commits, rebase conflict alerts)
- Strict skills mode (settings.skills = ["!*"]) and extension-bundled skills auto-discovery
- Generic package integration: vendor npm packages via package.json dependencies + auto npm install
- Companion delete: extensions ↔ same-name skills cascade cleanup

### Changed
- UI copy fully English (comments stay Chinese); session cards refresh every 3s without reload
- session-vcs archives commit immediately (no longer dependent on extension order)

### Removed
- Long-term memory mechanism (sessions only); legacy command aliases

[0.7.0]: https://github.com/oc101363-creator/pi-dpi/compare/...TBD
```

（版本对比链接先留 `...TBD`——实际发布时填）

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: add CHANGELOG (0.7.0 + unreleased)"
```

---

## Task 6: 英文 README（README.en.md）

**Files:**
- Create: `README.en.md`

**Interfaces:**
- Produces: 完整英文版 README（对外默认入口）；README.md（中文）保留并存，顶部互链

- [ ] **Step 1: 在 README.md 顶部加英文链接**

在 README.md 第一行 `# pi-dpi — dπ：拆解 π` 下方插入：

```markdown
> English: [README.en.md](README.en.md) | 中文: 本文件
```

- [ ] **Step 2: 创建 README.en.md（全文英文翻译）**

完整翻译现有 README.md 的所有章节（Install、/dpi-agent-login usage、远端类型矩阵、命令表、内容仓库结构约定、per-agent 扩展、superpowers 支持、机器层配置、配置与数据位置、隐私提醒）。保持结构一致、术语统一（content repo / agent manifest / registry / extension gate / strict skills mode 等）。

- [ ] **Step 3: Commit**

```bash
git add README.en.md README.md
git commit -m "docs: add English README (cross-linked with Chinese)"
```

---

## Task 7: npm 发布就绪检查清单（不实际发布）

**Files:**
- Create: `docs/npm-publish-checklist.md`
- Modify: `package.json`（files 数组补 templates/README.en.md/CHANGELOG.md）

**Interfaces:**
- Consumes: Task 1/5/6 的产物
- Produces: 发布前检查清单 + package.json 发布字段完整

- [ ] **Step 1: 补 package.json files 数组**

确认 files 字段为：

```json
  "files": [
    "extensions",
    "src",
    "templates",
    "README.md",
    "README.en.md",
    "CHANGELOG.md"
  ],
```

- [ ] **Step 2: 创建 docs/npm-publish-checklist.md**

```markdown
# npm Publish Checklist

1. `npm whoami` — confirm you're logged in to npm with publish rights for the scope
2. Update version in `package.json` (semver) and add a CHANGELOG entry
3. `npm run typecheck && npm run test` — all green
4. `npm pack --dry-run` — verify tarball contents (no node_modules, no .git, includes files listed)
5. `npm publish` (or `npm publish --tag beta` for a pre-release)
6. Verify: `pi install npm:<package>@<version>` on a clean machine
7. Tag the release: `git tag v<version> && git push --tags`
```

- [ ] **Step 3: 本地验证 npm pack 内容**

Run: `cd software/pi-dpi-main && npm pack --dry-run 2>&1 | head -30`
Expected: tarball 列表包含 extensions/、src/、templates/、README*.md、CHANGELOG.md；不含 node_modules/.git

- [ ] **Step 4: Commit**

```bash
git add docs/npm-publish-checklist.md package.json
git commit -m "chore(release): npm publish checklist and files field"
```

---

## Task 8: CONTRIBUTING + issue/PR 模板

**Files:**
- Create: `CONTRIBUTING.md`、`.github/ISSUE_TEMPLATE/bug_report.md`、`.github/ISSUE_TEMPLATE/feature_request.md`、`.github/PULL_REQUEST_TEMPLATE.md`

**Interfaces:**
- Produces: 社区协作规范文档

- [ ] **Step 1: 创建 CONTRIBUTING.md**

```markdown
# Contributing

## Setup
- `npm ci`（安装 devDependencies：vitest、typescript）
- `npm run typecheck`、`npm run test` — all green before committing

## Code style
- TypeScript strict; run `npx tsc --noEmit`
- Shared code in `src/` (never in `extensions/` — every `.ts` there is a pi extension entry)
- UI copy in English; code comments in Chinese
- Silent fault-tolerance: never throw on startup/read paths; fail loudly only on user commands

## Commits
Conventional Commits: `feat:` / `fix:` / `refactor:` / `docs:` / `test:` / `ci:` / `chore:`

## Tests
- Pure functions (config, git, registry logic) must have vitest coverage
- TDD: write failing test first

## Pull requests
- Describe the problem, the fix, and how you verified it
- Link related issues
```

- [ ] **Step 2: 创建 issue/PR 模板**

`.github/ISSUE_TEMPLATE/bug_report.md`：
```markdown
---
name: Bug report
---
**Describe the bug**

**Steps to reproduce**

**Expected behavior**

**Environment** (pi version, OS, dpi version)
```

`.github/ISSUE_TEMPLATE/feature_request.md`：
```markdown
---
name: Feature request
---
**Problem you're trying to solve**

**Proposed solution**

**Alternatives considered**
```

`.github/PULL_REQUEST_TEMPLATE.md`：
```markdown
**What**

**Why**

**Verification** (typecheck/test results)
```

- [ ] **Step 3: Commit**

```bash
git add CONTRIBUTING.md .github/
git commit -m "docs: CONTRIBUTING and issue/PR templates"
```

---

## 验证收尾

全部 Task 完成后：
- [ ] `tsc --noEmit && npm run test` 全绿（≥44 个测试）
- [ ] CI 在 main 分支运行通过（Task 4 推送后确认）
- [ ] `npm pack --dry-run` 内容正确（Task 7）
- [ ] 同步到已安装的 `~/.pi/agent/git/github.com/oc101363-creator/pi-dpi/`（rsync）并提交推送
