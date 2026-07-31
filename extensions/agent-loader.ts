/**
 * agent-loader：当前 agent 解析（移植自旧内容仓库 extensions/agent-loader.ts）。
 *
 * - resources_discover：按当前 agent 的 agent.json 声明，从仓库根 skills/ 注册表
 *   返回该 agent 的技能目录（技能隔离的裁决点：未声明的技能不进会话）+
 *   agents/<agent>/prompts
 * - before_agent_start：把 agents/<当前agent>/SYSTEM.md 链式注入系统提示词
 * - 面板实时化：3 秒定时器无条件重绘 agent 卡片（技能声明 + Sync 远端状态）——
 *   面板永远反映最新声明与同步结果，不依赖 reload。
 *   注：技能真正注入（resources_discover）仍需启动/reload（pi 平台限制——
 *   扩展无法程序化触发 reload，sendUserMessage 跳过命令处理），但面板
 *   （用户看到的技能列表）是实时的。
 * - /agent [name]：查看/交互或直接切换当前 agent（写入 dpi 配置 + ctx.reload() 让新技能生效）
 *
 * 内容仓库路径全部来自 dpi 配置（config.repoPath）；未绑定时所有 hook 静默 no-op。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  loadConfig,
  readAgentManifest,
  saveConfig,
  scanAgents,
  syncExtensionFilter,
} from "../src/config.ts";
import { safeAgentName } from "../src/common.ts";
import { showVimListPicker } from "../src/vim-list-picker.ts";
import {
  formatSyncStatus,
  pendingCommits,
  readSaveState,
  remoteSyncLine,
  syncStatusShort,
} from "../src/save-state.ts";
import { registerDpiCommand } from "../src/command-alias.ts";

// ---------- 内容仓库路径（每次调用时从配置取，切换绑定即时生效） ----------

function repoPath(): string | null {
  const cfg = loadConfig();
  return cfg.repoUrl ? cfg.repoPath : null;
}

function currentAgent(): string {
  return safeAgentName(loadConfig().currentAgent);
}

// ---------- agent 卡片（TUI 面板） ----------

// 列出提示词模板（xxx.md → /xxx）
function readPrompts(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => `/${f.replace(/\.md$/, "")}`)
    .sort();
}

// 取 SYSTEM.md 首行非标题、非空文本作为 agent 一句话简介（agent.json 无 description 时的回退）
function agentTitle(repo: string, agent: string): string {
  try {
    const head = readFileSync(join(repo, "agents", agent, "SYSTEM.md"), "utf-8").slice(0, 1000);
    const line = head
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith("#"));
    if (!line) return "";
    return line.length > 40 ? `${line.slice(0, 39)}…` : line;
  } catch {
    return "";
  }
}

// Sync 段缓存：pendingCommits 是 git 子进程（慢），只在会话生命周期点刷新；
// 面板每轮/定时重绘时用缓存，避免高频 git 调用
let syncCache = { text: "… 尚无保存记录", short: "sync: ?" };

/** 刷新 Sync 缓存（异步，调用方不阻塞等待） */
async function refreshSyncCache(): Promise<void> {
  try {
    const cfg = loadConfig();
    const pending = cfg.repoUrl ? await pendingCommits(cfg) : null;
    const state = readSaveState();
    syncCache = {
      text: formatSyncStatus(state, pending),
      short: syncStatusShort(state, pending),
    };
  } catch {
    // 状态不可用保留旧缓存
  }
}

// 渲染当前 agent 卡片：完全复刻 pi 原生资源面板（[节标题] mdHeading 色 + dim 色缩进内容 + 节间空行）
function showAgentCard(ctx: ExtensionContext, agent: string): void {
  if (!ctx.hasUI) return;
  const repo = repoPath();
  if (!repo) return;
  const manifest = readAgentManifest(repo, agent);
  const title = manifest.description ?? agentTitle(repo, agent);
  // 技能列表来自 agent.json 声明，逐一校验注册表 skills/<name>/SKILL.md 存在
  const skills = manifest.skills.filter((name) =>
    existsSync(join(repo, "skills", name, "SKILL.md")),
  );
  // 扩展列表同理：单文件或目录型（extensions/<name>/index.ts）都校验（与 syncExtensionFilter 对称）
  const extensions = manifest.extensions.filter((name) => {
    const dir = join(repo, "extensions", name);
    return (
      existsSync(join(repo, "extensions", `${name}.ts`)) ||
      existsSync(join(dir, "index.ts"))
    );
  });
  const prompts = readPrompts(join(repo, "agents", agent, "prompts"));

  ctx.ui.setWidget("agent-world", (_tui, theme) => {
    const section = (name: string, body: string) =>
      `${theme.fg("mdHeading", `[${name}]`)}\n${theme.fg("dim", `  ${body}`)}`;
    const sections = [section("Agent", title ? `${agent} — ${title}` : agent)];
    if (skills.length > 0) sections.push(section("Skills", skills.join(", ")));
    if (extensions.length > 0) sections.push(section("Extensions", extensions.join(", ")));
    if (prompts.length > 0) sections.push(section("Prompts", prompts.join(", ")));
    sections.push(section("Sync", `${syncCache.text}\n  ${remoteSyncLine()}`));
    return new Text(sections.join("\n\n"), 0, 0);
  });
  ctx.ui.setStatus("agent-world", `agent: ${agent}`);
  ctx.ui.setStatus("dpi-sync", syncCache.short);
}

export default function (pi: ExtensionAPI) {
  // 卡片在 resources_discover 渲染（startup/reload）——此时 dpi-sync 的
  // session_start pull 已 await 完成，读到的是 GitHub 最新声明（时序确定）
  pi.on("resources_discover", async (event, ctx) => {
    if (event.reason !== "startup" && event.reason !== "reload") return;
    if (!repoPath()) return;
    void refreshSyncCache(); // 不阻塞渲染
    showAgentCard(ctx, currentAgent());
  });

  // 面板实时化：3 秒定时器重绘卡片（技能声明 + Sync 远端状态永远最新），
  // 不依赖用户输入、不依赖 reload。ctx 生命周期与会话一致，存模块级引用。
  let watchTimer: ReturnType<typeof setInterval> | null = null;
  let sessionCtx: ExtensionContext | null = null;
  pi.on("session_start", async (_event, ctx) => {
    if (watchTimer) clearInterval(watchTimer);
    sessionCtx = ctx;
    if (!repoPath()) return;
    void refreshSyncCache();
    showAgentCard(ctx, currentAgent());
    watchTimer = setInterval(() => {
      const agent = currentAgent();
      const repo = repoPath();
      const c = sessionCtx;
      if (!repo || !c) return;
      // 无条件重绘：声明变化与远端同步状态都实时反映（差量渲染，成本低）
      showAgentCard(c, agent);
    }, 3000);
  });
  pi.on("session_shutdown", () => {
    if (watchTimer) {
      clearInterval(watchTimer);
      watchTimer = null;
    }
    sessionCtx = null;
  });

  // 每轮开始前：注入 SYSTEM.md + 顺手刷新面板（保证轮开始时正确）
  pi.on("before_agent_start", async (event, ctx) => {
    const repo = repoPath();
    if (!repo) return;
    const agent = currentAgent();
    showAgentCard(ctx, agent);
    const file = join(repo, "agents", agent, "SYSTEM.md");
    if (!existsSync(file)) return;
    const content = readFileSync(file, "utf-8").trim();
    if (!content) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${content}` };
  });

  // 技能发现的裁决点：注册表声明技能（agent.json skills）+
  // 声明扩展的自带技能（extensions/<name>/skills/——扩展 = 自包含单元，
  // 声明扩展即声明其技能，不拆散复制进注册表）。未声明的技能不进会话。
  pi.on("resources_discover", async () => {
    const repo = repoPath();
    if (!repo) return {};
    const agent = currentAgent();
    const manifest = readAgentManifest(repo, agent);
    const skillPaths = [
      // 注册表声明技能
      ...manifest.skills
        .map((name) => join(repo, "skills", name))
        .filter((dir) => existsSync(join(dir, "SKILL.md"))),
      // 扩展自带技能（目录型扩展的 skills/ 子目录）
      ...manifest.extensions
        .map((name) => join(repo, "extensions", name, "skills"))
        .filter((dir) => existsSync(dir)),
    ];
    const promptPaths: string[] = [];
    const promptsDir = join(repo, "agents", agent, "prompts");
    if (existsSync(promptsDir)) promptPaths.push(promptsDir);
    return { skillPaths, promptPaths };
  });

  // /agent [name]：带参数直接切换；无参数时交互选择或报告当前 agent
  registerDpiCommand(pi, "dpi-agent", {
    description: "切换当前 agent；无参数时列出所有 agent 供选择",
    handler: async (args, ctx) => {
      const repo = repoPath();
      if (!repo) {
        ctx.ui.notify("未绑定内容仓库，请先 /agent-login", "warning");
        return;
      }
      const agents = scanAgents(repo);
      const name = (args ?? "").trim();
      if (name) {
        // agents 来自目录扫描，includes 校验同时起到防路径穿越作用
        if (!agents.includes(name)) {
          ctx.ui.notify(`未知 agent: ${name}（可用: ${agents.join(", ") || "无"}）`, "error");
          return;
        }
        saveConfig({ currentAgent: name });
        showAgentCard(ctx, name);
        // 重载前先同步扩展过滤器，让 reload 按新 agent 的扩展声明隔离加载
        syncExtensionFilter(loadConfig());
        ctx.ui.notify(`已切换到 agent: ${name}，正在重载资源…`, "info");
        // 重载让 resources_discover 按新 agent 的声明重新发现技能
        await ctx.reload();
        return;
      }
      const current = currentAgent();
      if (!ctx.hasUI) {
        ctx.ui.notify(`当前 agent: ${current}`, "info");
        return;
      }
      if (agents.length === 0) {
        ctx.ui.notify(`当前 agent: ${current}（agents/ 下暂无可用 agent）`, "info");
        return;
      }
      // vim 选择器（select 模式），光标预定位当前 agent；description 作后缀
      const items = agents.map((name) => {
        const desc = readAgentManifest(repo, name).description;
        return {
          id: name,
          label: desc ? `${name} — ${desc}` : name,
          data: name,
        };
      });
      const res = await showVimListPicker(ctx, {
        title: `选择 agent（当前: ${current}）`,
        items,
        mode: "select",
        initialId: current,
      });
      const picked = res?.action === "pick" ? res.item?.data : undefined;
      if (!picked) return; // 用户取消，不做更改
      saveConfig({ currentAgent: picked });
      showAgentCard(ctx, picked);
      // 重载前先同步扩展过滤器，让 reload 按新 agent 的扩展声明隔离加载
      syncExtensionFilter(loadConfig());
      ctx.ui.notify(`已切换到 agent: ${picked}，正在重载资源…`, "info");
      await ctx.reload();
    },
  });
}
