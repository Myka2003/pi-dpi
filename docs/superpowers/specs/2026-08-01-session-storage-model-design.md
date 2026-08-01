# Session 存储模型重构设计（稀疏检出 + 按需拉取）

> Status: Approved (2026-08-01)

## 背景与问题

内容仓库随使用膨胀：sessions/ 归档 89 个会话已达 357MB，`/dpi-agent-login` 全量克隆需要 5 分钟+，且会越来越糟。运行时依赖（agents/skills/extensions）很小但每轮读取，会话归档很大但低频按需访问——两者混在同一个 git 工作区里全量克隆，是设计缺陷。

## 设计决策

**核心原则**：配置本地，数据按需。

- `agents/ skills/ extensions/ machines/ docs/`：克隆到本地工作区（小、运行时每轮读取、必须离线可用）
- `sessions/`：**永不进入工作区**——浏览用 git 元数据，恢复/归档按需操作 git 对象库
- 纯在线（用户确认：pi 使用本身依赖 LLM 网络，离线不是场景）

## 架构

```
┌─ 本地工作区（sparse-checkout）─────────────────────────┐
│  agents/ skills/ extensions/ machines/ docs/           │  ← 运行时配置，克隆即得
└────────────────────────────────────────────────────────┘
┌─ git 对象库（blob:none，按需拉 blob）──────────────────┐
│  sessions/ 的 blob 不存在于本地，访问时从远端按需拉取   │
└────────────────────────────────────────────────────────┘
```

### 克隆（ensureRepo）

```bash
git clone --filter=blob:none --sparse <repo> <repoPath>
git sparse-checkout set agents skills extensions machines docs
```

- `--filter=blob:none`：克隆只拉 commit/tree 骨架，blob（文件内容）按需
- `sparse set`：工作区只检出配置目录（几 MB，秒级）
- 保留现有分支退化逻辑（main 克隆失败 → 默认分支）

### 浏览归档（/dpi-sessions）

```bash
git ls-tree -r --long origin/main sessions/   # 文件名、大小、blob id——元数据，不下载内容
```

- 打开前确保 fetch 过（3 秒监听已维护 origin/main 最新；兜底再 fetch 一次）
- 排序键：文件名时间戳（`2026-07-28T06-42-54-735Z_<uuid>.jsonl` 开头即开始时间）——无需拉内容
- 名字懒加载：列表只显示 `[agent] 文件名 · 大小 · 时间`；选中时 `git show <blob>` 拉单文件解析 session_info 名字，子菜单标题显示
- 子目录扫描：`git ls-tree` 列 `sessions/<agent>/` 各 agent 目录（含 `_legacy`）

### 恢复（restoreArchived）

```bash
git show origin/main:sessions/<agent>/<file>.jsonl > 本机会话目录/<file>.jsonl
```

- 按需拉单个 blob（一个会话几 MB 内）
- 后续逻辑不变：改写首行 cwd → switchSession

### 归档（session_shutdown）

不经过工作区，直接写 git 对象库：

```bash
git hash-object -w <本机会话文件>                              # 写入 blob
git update-index --add --cacheinfo 100644 <blob> sessions/<agent>/<file>.jsonl  # 登记 index
git commit -m "[sync] archive session"                         # 提交
git push                                                       # 推送（dpi-sync 统一）
```

- `update-index --cacheinfo` 允许 index 登记工作区不存在的路径——sessions/ 永远不在工作区
- 重命名：追加 session_info 后，`git hash-object -w` 新内容 → `update-index --add` 同路径 → commit
- 删除：`git update-index --force-remove sessions/<agent>/<file>.jsonl` → commit

### 3 秒远端监听

不变。`git fetch` 只拉 commit/tree 增量（不拉 blob），保持轻量；agent.json 的 blob 因配置目录已 checkout，变化检测照常。

## 组件与接口

| 文件 | 改动 | 职责 |
|---|---|---|
| `src/git.ts` | 新增辅助 | `gitLsTree(repo, path)`、`gitShow(repo, ref, path)`、`gitHashObject(repo, file)`、`gitUpdateIndex(repo, path, blob, mode)`、`gitIndexRemove(repo, path)`——全部复用现有 credential/proxy/超时封装 |
| `extensions/dpi-auth.ts` | ensureRepo | 稀疏克隆 + sparse-checkout set |
| `src/sessions-shared.ts` | scanArchived | 从目录扫描改为 git ls-tree 元数据；`parseArchived` 保留（懒加载名字时用）；sortKey 改文件名时间戳 |
| `extensions/session-browser.ts` | restore/rename/delete | git show 恢复、update-index 直写 |
| `extensions/session-vcs.ts` | session_shutdown | 归档改 hash-object + update-index |
| `src/session-picker.ts` | 展示 | 列表项 `[agent] 文件名 · 大小`；懒加载名字 |

## 错误处理

- 所有 git 辅助沿用现有容错：失败静默/超时 8s，绝不阻断 pi 启动
- 列表加载失败：显示「需要网络（fetch 失败）」提示，不崩溃
- 恢复失败：notify 错误（现有逻辑）
- 归档失败：静默（现有逻辑），本地会话文件保留

## 测试

- `gitLsTree`/`gitShow`/`gitHashObject`/`gitUpdateIndex` 的辅助：在临时 git 仓库上集成测试（vitest 内 `git init` + 稀疏 + 验证）
- `scanArchived` 改元数据后：文件名排序/子目录扫描/懒加载名字的单元测试（用本地临时仓库模拟）
- 端到端冒烟（手动）：新克隆秒级、浏览不下载内容、恢复单文件、归档后 `git ls-tree` 可见

## 边界与已知限制

- 纯在线：浏览/恢复/归档需要网络（已确认）
- 远端历史 357MB 保留在 GitHub（新克隆不拉 blob，不影响 onboarding）
- 老机器重装走新流程（已确认，无迁移逻辑）
- 归档的 `git ls-tree` 需要先 fetch——3 秒监听保证最新，极端情况下（刚 push 未到 3 秒）列表可能少一条，下次轮询补齐
