# 2026-08-03 skill/扩展一键安装设计

## 目标

让 dpi 具备「一键安装 skill / 扩展」的能力，替代手动去 GitHub 找文件、下载、放进仓库的流程。

- 主入口是交互界面：`/dpi-skills` 与 `/dpi-extensions` 列表末尾增加「添加」项，点开后输入 GitHub 链接（或 npm 包名）回车即安装。
- 附带 CLI 化：`/dpi-skills add <url>`、`/dpi-extensions add <url|pkg>`。
- 来源：skill 与扩展都以 **GitHub 链接优先**（npx skills 生态思路：仓库根链接自动探测，或 `owner/repo` + 具体路径）；扩展额外支持 **npm 包名**（`pi-mcp-adapter` / `npm:pi-mcp-adapter`）。
- 安装与声明**解耦**：安装只负责拉取进内容仓库 + commit + push；是否启用由 `/dpi-skills`、`/dpi-extensions` 手动勾选（agent.json 声明）。

## 现状

| 环节 | 现状 |
|---|---|
| skill 安装 | 手动去 GitHub/skills.sh 找 `SKILL.md` → 下载 → 放 `Agent/skills/<name>/` → agent.json 声明 → commit+push |
| 扩展安装 | 内容仓库 `Agent/extensions/<name>.ts`（声明式）或 `pi install npm <pkg>`（pi 原生，settings.json 登记） |
| 依赖安装 | `ensureRepoDeps` 会 npm install 仓库 package.json 的 dependencies |
| 扩展过滤 | `syncExtensionFilter` 把 agent.json 声明的扩展路径写进 settings.json packages 的 `{source, extensions:[...]}` 过滤器；npm 包同样支持该对象形式 |

## 设计

### 1. 入口

- `/dpi-skills` 列表末尾固定项：`+ Add skill from GitHub`
- `/dpi-extensions` 列表末尾固定项：`+ Add extension (GitHub / npm)`
- 点开后 `ctx.ui.input` 输入链接/包名（复用 agent-login 的输入风格），回车安装
- CLI：`/dpi-skills add <url>`、`/dpi-extensions add <url|pkg>`（同一实现，handler 参数直通）

### 2. skill 安装链路（GitHub）

```
输入 https://github.com/owner/repo（或 owner/repo，或带具体路径 tree/main/skills/<name>）
  → 解析 owner/repo
  → 仓库根链接：GitHub API 探测 skills/ 下含 SKILL.md 的目录
      → 多个 skill → 列表选择（VimListPicker）；单个 → 直接装
  → 下载 SKILL.md + 同目录引用文件（references/ 递归，API 按需拉取，不 clone 整仓）
  → 落点 Agent/skills/<name>/（name 取 frontmatter name 或目录名，冲突时提示/询问）
  → git add + commit + push（带认证与代理）
  → notify「已装；用 /dpi-skills 勾选启用」（不自动声明，解耦）
```

### 3. 扩展安装链路

```
GitHub 链接 → 探测 extensions/（*.ts 单文件或目录型 index.ts）
            → 下载到 Agent/extensions/<name>/ → commit + push → 同上提示

npm 包名（pi-mcp-adapter / npm:pi-mcp-adapter）
            → 执行 pi install npm <pkg>（pi 原生装到 ~/.pi/agent/npm/ + settings.json 登记）
            → 包内扩展由 pi 读 package.json 的 pi.extensions manifest 自动发现
            → dpi 把依赖记录进仓库（跨机器同步声明）→ commit + push
```

### 4. 组件

| 组件 | 职责 |
|---|---|
| `src/github-source.ts` | URL/包名解析：GitHub URL → `{owner, repo, path?}`；npm 名识别；GitHub API 封装（列表目录、按需拉文件，复用代理/认证） |
| `src/skill-installer.ts` | skill 安装编排：探测 → 选择 → 下载 → 落库 → 提交推送 |
| `src/extension-installer.ts` | 扩展安装编排：GitHub 分支 + npm 分支 |
| `extensions/skill-manager.ts` | 注册表尾部追加「+ Add skill from GitHub」入口，联动 installer |
| `extensions/ext-manager.ts` | 注册表尾部追加「+ Add extension」，联动 installer |
| `src/git.ts` | 复用 commit/push（认证/代理） |

### 5. 错误处理

- 无效链接 / 仓库不存在 / 无 skills|extensions 目录 → notify 明确错误，不破坏会话
- 下载失败（网络/限速）→ 报错并可重试，已下载部分回滚（清理临时文件）
- 名称冲突（`skills/<name>` 已存在）→ 询问覆盖 / 跳过 / 换名
- 全部容错：任何一步失败都不抛异常阻断 pi

### 6. 测试

- 单测：GitHub URL 解析（仓库根 / owner/repo / 带路径 tree / raw 等变体）、npm 名识别
- 集成：本地临时 git 仓库模拟远端，验证安装落点与 commit 内容
- 手动冒烟：装一个真实 skill（如 find-skills）与 npm 扩展（如 pi-mcp-adapter）

### 7. 范围外

- 不自动声明 agent（解耦，手动勾选）
- 只支持 GitHub（GitLab/Bitbucket 以后再说）
- 不做版本更新/卸载（现有删除入口已覆盖）
- npm 包不拷贝进内容仓库（引用式，pi 原生管理）
