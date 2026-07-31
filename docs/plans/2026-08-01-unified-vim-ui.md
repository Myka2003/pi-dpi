# pi-dpi 统一 vim 风格 UI + 命令前缀 实施计划

**Goal：** 解决三个问题——(1) session-picker 的翻页键不支持笔记本（MacBook 无 PgUp/PgDn），
(2) 插件交互不统一（只有 /sessions 是 vim 风格，/skills /extensions /agent 仍是普通 select），
(3) 命令名无前缀易与别的包冲突，统一加 `/dpi-` 前缀。

**Architecture：** 把 session-picker 泛化为可复用的 `VimListPicker`（src/vim-list-picker.ts），
支持 select（单选）与 toggle（多选勾选）两种模式 + 自定义动作键注入；session-picker 成为
它的 session 专用包装。registry-manager 主循环（/skills /extensions）换 toggle 模式；
/agent 切换换 select 模式；删除流程保留。命令双注册 `/dpi-<name>` 新名 + `/<name>` 旧 alias。

**Tech Stack：** TypeScript + pi Extension API（ctx.ui.custom）+ vitest。

## Global Constraints

- 共享代码放 `src/`（extensions/ 下每个 .ts 都是扩展入口，无 default 导出会报加载错误）
- `tsc --noEmit` 与 `npm run test` 必须全绿后才提交
- 每个 Task 独立可测、独立提交；遵循 README 的静默容错原则（绝不让 pi 启动失败）
- 笔记本键盘优先：所有翻页必须有无功能键的 vim 替代（^D/^U 半页、^F/^B 整页）
- 命令新旧并存：新 `/dpi-` 前缀为正式名，旧名注册为 alias（README 只宣传新名）

---

## 文件结构

```
software/pi-dpi-main/
├── src/
│   ├── vim-list-picker.ts     # 新建：泛型 vim 列表选择器（select/toggle 双模式）
│   ├── session-picker.ts      # 改写：VimListPicker 的 session 专用包装（标题行+条目格式）
│   ├── sessions-shared.ts     # 不动（解析/标题/扫描）
│   ├── registry-manager.ts    # 修改：主循环从 select 循环换成 VimListPicker（toggle 模式）
│   ├── common.ts              # 不动
│   ├── config.ts              # 不动
│   └── git.ts                 # 不动
├── extensions/
│   ├── session-browser.ts     # 修改：改用 session-picker 包装（接口不变）
│   ├── agent-loader.ts        # 修改：/agent 交互选择换 VimListPicker（select 模式）
│   ├── dpi-auth.ts            # 修改：/agent-login → /dpi-agent-login（+alias）
│   ├── dpi-sync.ts            # 修改：/sync → /dpi-sync（+alias）
│   ├── skill-manager.ts       # 修改：/skills → /dpi-skills（+alias），主循环走 registry-manager 新实现
│   ├── ext-manager.ts         # 修改：/extensions → /dpi-extensions（+alias），同上
│   ├── session-vcs.ts         # 修改：/record /session-repair → /dpi-record /dpi-session-repair（+alias）
│   └── extension-gate.ts      # 不动
│   └── guardrails.ts          # 不动
├── test/
│   └── vim-list-picker.test.ts # 新建：按键状态机纯逻辑测试（页码/跳转/过滤/toggle）
└── README.md                  # 修改：命令表全换 /dpi- 前缀 + vim 导航说明
```

---

## Task 1: 笔记本翻页键（session-picker 补 ^D/^U ^F/^B）

**Files:**
- Modify: `src/session-picker.ts`（handleInput + 底栏提示）
- Test: `test/vim-list-picker.test.ts`（先在 Task 2 创建，此处只加按键分支，测试后补）

**Interfaces:**
- Produces: `SessionPicker.handleInput(data)` 支持 `Key.ctrl("d")` / `Key.ctrl("u")` / `Key.ctrl("f")` / `Key.ctrl("b")`

- [ ] **Step 1: 在 moveDown/moveUp 基础上加半页/整页移动**

在 SessionPicker 类中 moveUp 之后加：

```typescript
/** 半页移动（vim ^D/^U） */
private moveHalf(down: boolean): void {
  const v = this.visible();
  if (v.length === 0) return;
  const step = Math.max(1, Math.floor(PAGE_SIZE / 2));
  for (let i = 0; i < step; i++) down ? this.moveDown() : this.moveUp();
}

/** 整页移动（vim ^F/^B，等价 PgDn/PgUp） */
private movePage(down: boolean): void {
  const v = this.visible();
  if (v.length === 0) return;
  if (down) {
    if (this.pageOffset + PAGE_SIZE < v.length) this.pageOffset += PAGE_SIZE;
    this.sel = Math.min(this.sel, this.page().length - 1);
  } else {
    this.pageOffset = Math.max(0, this.pageOffset - PAGE_SIZE);
    this.sel = Math.min(this.sel, this.page().length - 1);
  }
}
```

- [ ] **Step 2: handleInput 导航模式接四个组合键**

在 `if (matchesKey(data, Key.pageUp)) return this.moveUp();` 之后插入：

```typescript
    if (matchesKey(data, Key.ctrl("d"))) return this.moveHalf(true);
    if (matchesKey(data, Key.ctrl("u"))) return this.moveHalf(false);
    if (matchesKey(data, Key.ctrl("f"))) return this.movePage(true);
    if (matchesKey(data, Key.ctrl("b"))) return this.movePage(false);
```

- [ ] **Step 3: 底栏提示更新（提示行里去掉 PgUp/PgDn 字样，避免误导笔记本用户）**

render 的 hints 改为：

```typescript
    const hints =
      this.mode === "search"
        ? "过滤输入中… Enter 确认 · Esc 清空退出"
        : "j/k 导航 · ^D/^U 半页 · ^F/^B 整页 · gg/G · / 过滤 · c 筛选 · Enter 选择 · Esc 取消";
```

- [ ] **Step 4: typecheck + 测试**

Run: `tsc --noEmit && npm run test`
Expected: 全绿（现有 21 个测试不受影响）

- [ ] **Step 5: Commit**

```bash
git add src/session-picker.ts
git commit -m "feat(session-picker): 笔记本翻页键 ^D/^U 半页 ^F/^B 整页"
```

---

## Task 2: 泛型 VimListPicker（select/toggle 双模式 + 动作键注入）

**Files:**
- Create: `src/vim-list-picker.ts`
- Test: `test/vim-list-picker.test.ts`

**Interfaces:**
- Consumes: `src/sessions-shared.ts` 不需要（picker 泛型化，格式化由调用方负责）
- Produces:
  ```typescript
  export interface VimListItem<T> {
    id: string;          // 稳定 ID
    label: string;       // 主显示文本
    meta?: string;       // 右侧后缀（如相对时间）
    checked?: boolean;   // toggle 模式初始勾选
    data: T;
  }
  export type VimListAction = "pick" | "cancel" | string; // string = 自定义动作键 id
  export interface VimListResult<T> {
    action: VimListAction;
    item?: VimListItem<T>;          // select 模式选中项 / 自定义动作的目标项
    checked?: string[];             // toggle 模式最终勾选的 id 集
  }
  export class VimListPicker<T> implements Component { ... }
  export function showVimListPicker<T>(
    ctx: ExtensionCommandContext,
    opts: {
      title: string;
      items: VimListItem<T>[];
      mode: "select" | "toggle";
      actions?: { key: string; id: string; hint: string }[]; // 自定义动作键（如 d=删除）
      hint?: string; // 底栏提示覆盖
    },
  ): Promise<VimListResult<T>>;
  ```

- [ ] **Step 1: 写核心按键状态机测试（纯逻辑，不依赖 TUI 渲染）**

VimListPicker 的导航状态（pageOffset/sel/filter/toggle）抽为可测的纯类 `VimListState`（不实现 Component）：
`test/vim-list-picker.test.ts`：

```typescript
import { describe, expect, it } from "vitest";
import { VimListState } from "../src/vim-list-picker.ts";

const items = Array.from({ length: 55 }, (_, i) => ({
  id: `i${i}`, label: `item-${i}`, data: i,
}));

describe("VimListState 分页/跳转/过滤", () => {
  it("moveDown 到页尾自动翻页，moveUp 到页首翻上一页", () => {
    const s = new VimListState(items, 20);
    for (let i = 0; i < 20; i++) s.moveDown();
    expect(s.pageOffset).toBe(20);
    expect(s.sel).toBe(0);
    s.moveUp();
    expect(s.pageOffset).toBe(0);
    expect(s.sel).toBe(19);
  });
  it("jump(false) 到最后一页最后一项", () => {
    const s = new VimListState(items, 20);
    s.jump(false);
    expect(s.pageOffset).toBe(40);
    expect(s.sel).toBe(14); // 55 项：40..54，末项页内 14
  });
  it("filter 过滤后总数变化且游标重置", () => {
    const s = new VimListState(items, 20);
    s.setFilter("item-5");
    expect(s.visible().length).toBe(6); // item-5, item-50..54
    expect(s.pageOffset).toBe(0);
    expect(s.sel).toBe(0);
  });
  it("toggle 切换勾选取最终 id 集", () => {
    const s = new VimListState(items, 20);
    s.toggleCurrent(); // item-0
    s.moveDown();
    s.toggleCurrent(); // item-1
    expect(s.checkedIds()).toEqual(["i0", "i1"]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/vim-list-picker.test.ts`
Expected: FAIL（VimListState 未定义）

- [ ] **Step 3: 实现 VimListState + VimListPicker 组件 + showVimListPicker**

完整实现 `src/vim-list-picker.ts`（~230 行）：VimListState（分页/过滤/跳转/toggle 纯逻辑）、
VimListPicker（Component：handleInput 接 j/k gg G ^D/^U ^F/^B PgUp/PgDn /过滤 c? 不用——
agent 筛选是调用方的事，picker 只管通用导航；toggle 模式空格/Enter 切换当前项）、
showVimListPicker（custom factory 包装）。按键表：

```
j/↓ 下移 · k/↑ 上移 · gg 首页 · G 末页
^D/^U 半页 · ^F/^B 整页 · PgUp/PgDn 整页
/ 过滤（Enter 确认 Esc 清空退出）
select 模式：Enter 选中
toggle 模式：Space/Enter 切换当前项勾选，Esc/q 完成返回
自定义动作键：opts.actions 声明（如 { key: "d", id: "delete", hint: "d 删除" }），
  按下即结束并返回 { action: id, item: 当前项 }
Esc/q/ctrl+c 取消（select 模式）或完成（toggle 模式）
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/vim-list-picker.test.ts`
Expected: 4 PASS

- [ ] **Step 5: Commit**

```bash
git add src/vim-list-picker.ts test/vim-list-picker.test.ts
git commit -m "feat(vim-list-picker): 泛型 vim 列表选择器（select/toggle 双模式）"
```

---

## Task 3: session-picker 改为 VimListPicker 包装

**Files:**
- Modify: `src/session-picker.ts`（重写为包装，~80 行）
- Modify: `extensions/session-browser.ts`（仅 showSessionPicker 调用签名适配）

**Interfaces:**
- Consumes: Task 2 的 `showVimListPicker`、`VimListItem`
- Produces: `showSessionPicker(ctx, entries, currentAgent): Promise<ArchivedSession | undefined>`（签名不变）

- [ ] **Step 1: 重写 session-picker 为薄包装**

`src/session-picker.ts`：把 ArchivedSession 映射为 VimListItem（label = `[agent] entryTitle`，
meta = relTime），select 模式；c 切换 agent 筛选作为 picker 的自定义动作（actions:
[{ key: "c", id: "cycle-filter", hint: "c 筛选" }]，外层循环按 action 切换 onlyCurrent 重开 picker）。

- [ ] **Step 2: session-browser 适配（外层循环处理 cycle-filter action）**

```typescript
let onlyCurrent = false;
for (;;) {
  const picked = await showSessionPicker(ctx, archivedNow, agent, onlyCurrent);
  if (picked === "cycle-filter") { onlyCurrent = !onlyCurrent; continue; }
  if (!picked) return;
  // 子菜单（原逻辑不变）
}
```

- [ ] **Step 3: typecheck + 测试**

Run: `tsc --noEmit && npm run test`
Expected: 全绿

- [ ] **Step 4: Commit**

```bash
git add src/session-picker.ts extensions/session-browser.ts
git commit -m "refactor(session-picker): 基于 VimListPicker 的 session 包装"
```

---

## Task 4: registry-manager 主循环换 VimListPicker（toggle 模式）

**Files:**
- Modify: `src/registry-manager.ts`
- Modify: `extensions/skill-manager.ts`、`extensions/ext-manager.ts`（仅薄壳配置不变）

**Interfaces:**
- Consumes: Task 2 的 `showVimListPicker`（toggle 模式 + d 删除动作键）
- Produces: `runRegistryManager` 行为等价（勾选/取消/删除/完成 reload）

- [ ] **Step 1: 主循环重写**

非 UI 分支保留。UI 分支改为：
```typescript
let deleted = false;
for (;;) {
  const registry = rc.scanRegistry(repo);
  const declared = rc.readDeclared(repo, agent);
  const items = registry.map((e) => ({
    id: e.name,
    label: e.description ? `${e.name} — ${e.description}` : e.name,
    checked: declared.includes(e.name),
    data: e,
  }));
  const res = await showVimListPicker(ctx, {
    title: `${rc.kindLabel} — ${agent}（● 已声明，空格切换，d 删除，Esc 完成）`,
    items, mode: "toggle",
    actions: [{ key: "d", id: "delete", hint: "d 删除" }],
  });
  if (res.action === "delete" && res.item) {
    if (await deleteFlow(ctx, repo, rc, res.item.data.name)) { dirty = true; deleted = true; }
    continue;
  }
  // 完成/取消：写回勾选集与声明的差集
  const next = res.checked ?? declared;
  if (JSON.stringify([...next].sort()) !== JSON.stringify([...declared].sort())) {
    if (!rc.writeDeclared(repo, agent, next)) {
      ctx.ui.notify(`写入 agents/${agent}/agent.json 失败`, "error");
    } else dirty = true;
  }
  break;
}
// 完成时：扩展先 syncExtensionFilter 再 reload（原逻辑）
```

deleteFlow 加参数支持预选目标（不再弹 select，直接 confirm）。

- [ ] **Step 2: typecheck + 测试**

Run: `tsc --noEmit && npm run test`
Expected: 全绿

- [ ] **Step 3: Commit**

```bash
git add src/registry-manager.ts
git commit -m "refactor(registry-manager): 主循环换 VimListPicker toggle 模式"
```

---

## Task 5: /agent 切换换 VimListPicker（select 模式）

**Files:**
- Modify: `extensions/agent-loader.ts`（/agent 无参数交互分支）

- [ ] **Step 1: 交互分支改造**

`ctx.ui.select("选择 agent…")` 替换为 showVimListPicker select 模式：
items = agents.map(name => ({ id: name, label: name + (description 后缀), data: name }))，
当前 agent 排前（picker 默认支持初始选中？加 `initialId` 选项让光标落在当前 agent 上）。

- [ ] **Step 2: typecheck + 测试 + Commit**

```bash
tsc --noEmit && npm run test
git add extensions/agent-loader.ts src/vim-list-picker.ts
git commit -m "refactor(agent): /agent 切换换 VimListPicker（当前 agent 预定位）"
```

---

## Task 6: 命令加 /dpi- 前缀（双注册 alias）

**Files:**
- Modify: `extensions/dpi-auth.ts`、`dpi-sync.ts`、`session-vcs.ts`、`skill-manager.ts`、`ext-manager.ts`、`session-browser.ts`、`agent-loader.ts`
- Modify: `README.md`

- [ ] **Step 1: 命令映射表（新名 = 正式，旧名 = alias，同一 handler）**

```
/dpi-agent-login    ← /agent-login
/dpi-agent-logout   ← /agent-logout
/dpi-agent          ← /agent
/dpi-skills         ← /skills
/dpi-extensions     ← /extensions
/dpi-sync           ← /sync
/dpi-record         ← /record
/dpi-sessions       ← /sessions
/dpi-session-repair ← /session-repair
```

实现：每个 registerCommand 后紧跟第二个 registerCommand（alias），同一 handler 函数引用。
pi.registerCommand 同名冲突不会（名字不同）；description 标注「旧名 alias，请用 /dpi-xxx」。

- [ ] **Step 2: README 更新**

命令表全换 /dpi- 前缀，加一行「旧命令名仍可用（alias），1.0 前移除」。

- [ ] **Step 3: typecheck + 测试 + Commit**

```bash
tsc --noEmit && npm run test
git add extensions/ README.md
git commit -m "feat(commands): 统一 /dpi- 前缀，旧命令保留 alias"
```

---

## Task 7: 保存状态可见性（让用户能确认“关机时会话存上了”）

**背景**：会话保存分三层——(1) pi 实时写本地 JSONL（消息级，pi 保证）；
(2) session_shutdown 时归档进仓库并 commit（session-vcs）；(3) push 到远端（dpi-sync）。
(2)(3) 是静默后台操作，用户无法确认退出时是否成功，断网/冲突时失败无感。
本任务让保存状态可见：状态文件追踪 + 面板常驻指示 + 保存进度通知 + 状态查询命令。

**Files:**
- Create: `src/save-state.ts`
- Modify: `extensions/session-vcs.ts`（commit 后写状态 + shutdown 进度 notify）
- Modify: `extensions/dpi-sync.ts`（push 后写状态）
- Modify: `extensions/agent-loader.ts`（卡片加 Sync 段 + setStatus）
- Modify: `extensions/dpi-sync.ts`（新增 /dpi-save-status 命令）
- Test: `test/save-state.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  // src/save-state.ts
  export interface SaveState {
    lastArchive?: { time: string; session: string; result: "committed" | "copied" };
    lastPush?: { time: string; result: "ok" | "failed"; error?: string };
  }
  export function readSaveState(): SaveState;      // 读 <dpiDir>/save-state.json（容错回退 {}）
  export function writeSaveState(patch: Partial<SaveState>): void; // 合并写回（0600）
  export function pendingCommits(cfg: DpiConfig): number | null; // git rev-list --count origin/<branch>..HEAD，失败 null
  export function formatSyncStatus(): { card: string; status: string }; // “✓ 已同步 5 分钟前” / “⚠ 3 个未推送” / “✗ 上次推送失败”
  ```

- [ ] **Step 1: 写 save-state 测试**

`test/save-state.test.ts`：readSaveState 缺失文件回退 {}；writeSaveState 合并写回；
formatSyncStatus 三种状态文案（已同步/未推送/失败）。

- [ ] **Step 2: 实现 src/save-state.ts**

状态文件 `<dpiDir>/save-state.json`（0600，与 config 同目录约定）；pendingCommits 用
`git rev-list --count origin/<branch>..HEAD`（branch 取 cfg.branch，本地仓库无 origin 时返回 null）；
formatSyncStatus 规则：
- lastPush.result === "ok" 且 pendingCommits === 0 → `✓ 已同步 <相对时间>`
- pendingCommits > 0 → `⚠ <N> 个未推送`
- lastPush.result === "failed" → `✗ 上次推送失败（<相对时间>）`
- 无任何记录 → `… 尚无保存记录`

- [ ] **Step 3: session-vcs 集成（归档状态 + 进度通知）**

session_shutdown 归档流程：开始前 `ctx.ui.notify("正在保存会话…", "info")`；
commitArchive 成功后 `writeSaveState({ lastArchive: { time: new Date().toISOString(), session: basename(file), result: "committed" } })`；
recordSessions=false 时 result: "copied"（只复制未 commit 也记录）。

- [ ] **Step 4: dpi-sync 集成（推送状态 + 状态命令）**

push 成功/失败都写 `writeSaveState({ lastPush: { time, result, error? } })`；
启动 autoSync 完成后若 pendingCommits > 0，notify「<N> 个提交未推送，退出时重试」。
新增命令 `/dpi-save-status`（+ alias `/save-status`）：notify 显示
最近归档时间/最近推送/未推送数/状态文案。

- [ ] **Step 5: agent-loader 卡片 + 底栏**

showAgentCard 的 sections 末尾加 `section("Sync", formatSyncStatus().card)`；
setStatus 第二状态：`sync: ✓` / `sync: ⚠3` / `sync: ✗`（session_start 时计算，
与 agent 状态并列）。

- [ ] **Step 6: typecheck + 测试 + Commit**

```bash
tsc --noEmit && npm run test
git add src/save-state.ts extensions/ test/save-state.test.ts
git commit -m "feat(sync-status): 保存状态可见——状态文件 + 面板指示 + 进度通知"
```

---

## Task 8: 全量验证 + 发布

- [ ] **Step 1: typecheck + 全测试**

Run: `tsc --noEmit && npm run test`
Expected: 全绿（≥24 个测试）

- [ ] **Step 2: 同步安装目录 + 提交**

```bash
rsync -az --delete --exclude .git --exclude node_modules ./ ~/.pi/agent/git/github.com/oc101363-creator/pi-dpi/
cd ~/.pi/agent/git/github.com/oc101363-creator/pi-dpi && git add -A && git commit -m "..."
```

- [ ] **Step 3: push**

```bash
git -c credential.helper= -c 'credential.helper=!f() { echo username=x-access-token; echo "password=$(cat ~/.pi/agent/dpi/token)"; }; f' push origin main
```

- [ ] **Step 4: 真机验证清单**

- /reload 后 `/dpi-sessions`：gg/G/^D/^U/^F/^B//过滤/c 筛选手感
- `/dpi-skills`、`/dpi-extensions`：空格勾选、d 删除、Esc 完成 reload
- `/dpi-agent`：光标预定位当前 agent
- 旧命令 `/sessions` 仍可用（alias）
- agent 卡片显示 Sync 段（✓/⚠/✗），底栏 sync 状态
- 退出 pi 时能看到「正在保存会话…」；`/dpi-save-status` 显示最近归档/推送/未推送数
