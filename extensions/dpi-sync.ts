/**
 * dpi-sync：内容仓库自动同步。
 *
 * - session_start（仅 reason==="startup"）：pull --rebase --autostash → 有改动才
 *   commit "[sync] sweep" → push
 * - session_shutdown：sweep → push
 * - /sync：手动执行完整同步并反馈结果
 *
 * 每步独立 try/catch 静默容错（自动路径 8s 超时）；github/http 远端带 credential
 * helper 与按需代理，ssh/local 远端零凭证不注入 helper、不走 http 代理。
 * 未绑定仓库或需要令牌的远端未登录时直接跳过。git 失败绝不能影响 pi 启动/退出。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { join } from "node:path";import { hasToken, loadConfig, remoteNeedsToken, tokenPath } from "../src/config.ts";
import { GIT_TIMEOUT, gitIn } from "../src/git.ts";
import type { GitOptions } from "../src/git.ts";
import { registerDpiCommand } from "../src/command-alias.ts";
import {
  formatSyncStatus,
  pendingCommits,
  readSaveState,
  remoteSyncLine,
  remoteSyncState,
  writeSaveState,
} from "../src/save-state.ts";

interface SyncTarget {
  repoPath: string;
  opts: GitOptions;
}

/** rebase 冲突中断检测：存在 rebase 元数据目录即处于未完成的重放状态 */
function rebaseInProgress(repoPath: string): boolean {
  return (
    existsSync(join(repoPath, ".git", "rebase-merge")) ||
    existsSync(join(repoPath, ".git", "rebase-apply"))
  );
}

/** 远端声明监听：git rev-parse 取远端/本地 agent.json 的 blob 版本对比 */
async function remoteDeclSha(
  t: SyncTarget,
  ref: string,
  agent: string,
): Promise<string> {
  const { stdout } = await gitIn(
    t.repoPath,
    ["rev-parse", `${ref}:agents/${agent}/agent.json`],
    { ...t.opts, timeoutMs: GIT_TIMEOUT },
  );
  return stdout.trim();
}

/** 远端监听轮次：fetch 更新远端引用 → 对比 agent.json 远端/本地 blob 版本；变了返回 true */
async function remoteDeclChanged(t: SyncTarget, cfg: { branch: string; currentAgent: string }): Promise<boolean> {
  try {
    await gitIn(t.repoPath, ["fetch", "origin"], t.opts);
    const remote = await remoteDeclSha(t, `origin/${cfg.branch}`, cfg.currentAgent);
    const local = await remoteDeclSha(t, "HEAD", cfg.currentAgent);
    return remote !== "" && local !== "" && remote !== local;
  } catch {
    return false; // fetch 失败静默（断网/凭据问题），下轮再试
  }
}

/** 同步前提检查：已绑定 + 需要令牌的类型已登录 + 本地仓库存在；不满足返回 null */
function target(): SyncTarget | null {  const cfg = loadConfig();
  if (!cfg.repoUrl || (remoteNeedsToken(cfg.remoteKind) && !hasToken())) return null;
  if (!existsSync(join(cfg.repoPath, ".git"))) return null;
  // ssh/local 零凭证：不注入 credential helper，也不走 http 代理
  const opts: GitOptions = remoteNeedsToken(cfg.remoteKind)
    ? { tokenFile: tokenPath(), proxy: cfg.proxy, timeoutMs: GIT_TIMEOUT }
    : { noAuth: true, proxy: "", timeoutMs: GIT_TIMEOUT };
  return { repoPath: cfg.repoPath, opts };
}

/** 清扫：暂存全部改动，有变更才提交；返回是否有提交产生 */
async function sweep(t: SyncTarget, message: string): Promise<boolean> {
  await gitIn(t.repoPath, ["add", "-A"], t.opts);
  const { stdout } = await gitIn(t.repoPath, ["status", "--porcelain"], t.opts);
  if (stdout.trim().length === 0) return false;
  await gitIn(t.repoPath, ["commit", "-m", message], t.opts);
  return true;
}

async function autoSync(onStartup: boolean): Promise<void> {
  const t = target();
  if (!t) return;
  if (onStartup) {
    try {
      await gitIn(t.repoPath, ["pull", "--rebase", "--autostash"], t.opts);
    } catch {
      // 拉取失败（离线/冲突）静默，不阻塞启动
    }
  }
  try {
    await sweep(t, "[sync] sweep");
  } catch {
    // 清扫失败静默
  }
  try {
    await gitIn(t.repoPath, ["push"], t.opts);
    writeSaveState({ lastPush: { time: new Date().toISOString(), result: "ok" } });
  } catch (e) {
    writeSaveState({
      lastPush: {
        time: new Date().toISOString(),
        result: "failed",
        error: e instanceof Error ? e.message : String(e),
      },
    });
  }
}

export default function (pi: ExtensionAPI) {
  // 所有会话启动/切换/重载都先同步远端（reload 时用户期望看到 GitHub 最新声明）；
  // pull 在 session_start 内 await 完成，resources_discover 在其后执行（时序确定）
  pi.on("session_start", async (event, ctx) => {
    try {
      await autoSync(true);
      // 启动/重载后提醒未推送的提交（断网/冲突遗留），用户能确认保存状态
      const cfg = loadConfig();
      if (cfg.repoUrl) {
        const pending = await pendingCommits(cfg);
        if (pending !== null && pending > 0) {
          ctx.ui.notify(`⚠ ${pending} unpushed commit${pending === 1 ? "" : "s"} (content repo), retried on exit`, "warning");
        }
        // rebase 冲突中断：同步已停摆，必须人工解决——亮出冲突状态
        if (rebaseInProgress(cfg.repoPath)) {
          ctx.ui.notify(
            "⚠ Unresolved rebase conflict in content repo, sync paused; resolve conflicts then /dpi-sync",
            "warning",
          );
        }
      }
    } catch {
      // 绝不阻塞启动
    }
  });

  // 远端声明监听：每 3 秒 fetch 检测 agent.json 远端/本地版本，变了立即 pull --rebase
  // （autostash 保护）。注意：pull 后必须主动触发 /reload——DeclarationWatch/
  // agent_settled 只在用户对话轮运行，用户看着面板不发消息时永远不会触发。
  // pi.sendUserMessage("/reload", followUp) 在空闲时立即执行、输入中则排队，安全。
  let watchTimer: ReturnType<typeof setInterval> | null = null;
  pi.on("session_start", async () => {
    if (watchTimer) clearInterval(watchTimer);
    const cfg = loadConfig();
    if (!cfg.repoUrl) return;
    const t = target();
    if (!t) return;
    watchTimer = setInterval(async () => {
      // 每轮先标记检测开始（面板显示 ⟳）
      remoteSyncState.pulling = true;
      remoteSyncState.lastCheck = Date.now();
      let changed = false;
      try {
        changed = await remoteDeclChanged(t, cfg);
        remoteSyncState.lastResult = "ok";
      } catch {
        remoteSyncState.lastResult = "failed";
        remoteSyncState.pulling = false;
        return;
      }
      if (changed) {
        try {
          await gitIn(t.repoPath, ["pull", "--rebase", "--autostash"], t.opts);
          remoteSyncState.lastPull = Date.now(); // 面板显示「已拉取远端变更」
        } catch {
          // 冲突/失败：状态留在 failed（rebase 中断已由 session_start 告警）
          remoteSyncState.lastResult = "failed";
        }
      }
      remoteSyncState.pulling = false;
    }, 3000);
  });

  pi.on("session_shutdown", async () => {
    if (watchTimer) {
      clearInterval(watchTimer);
      watchTimer = null;
    }
  });

  pi.on("session_shutdown", async () => {
    try {
      await autoSync(false);
    } catch {
      // 静默
    }
  });

  // /sync：手动完整同步（拉 → 扫 → 推），结果显式反馈
  registerDpiCommand(pi, "dpi-sync", {
    description: "Sync content repo: pull --rebase → sweep commit → push; auto-reload on declaration change",
    handler: async (_args, ctx) => {
      const t = target();
      if (!t) {
        ctx.ui.notify("No content repo bound or not logged in, run /dpi-agent-login first", "warning");
        return;
      }
      // pull 前记录 agent.json 的 git 版本指纹，用于检测远端更新
      const cfg = loadConfig();
      const agent = /^[\w-]+$/.test(cfg.currentAgent) ? cfg.currentAgent : "coder";
      const declPath = `agents/${agent}/agent.json`;
      let declBefore = "";
      try {
        const { stdout } = await gitIn(t.repoPath, ["rev-parse", `HEAD:${declPath}`], {
          ...t.opts,
          timeoutMs: 8000,
        });
        declBefore = stdout.trim();
      } catch {
        // 文件未跟踪/无历史：跳过指纹对比
      }
      try {
        await gitIn(t.repoPath, ["pull", "--rebase", "--autostash"], {
          ...t.opts,
          timeoutMs: 60000,
        });
        const committed = await sweep(t, "[sync] sweep");
        await gitIn(t.repoPath, ["push"], { ...t.opts, timeoutMs: 60000 });
        // 声明文件被远端更新（指纹变化）→ 自动重载让新技能/扩展生效
        let declAfter = "";
        try {
          const { stdout } = await gitIn(t.repoPath, ["rev-parse", `HEAD:${declPath}`], {
            ...t.opts,
            timeoutMs: 8000,
          });
          declAfter = stdout.trim();
        } catch {
          // 忽略
        }
        if (declBefore !== "" && declAfter !== "" && declBefore !== declAfter) {
          ctx.ui.notify("Sync complete: agent.json updated, reloading…", "info");
          await ctx.reload();
          return;
        }
        ctx.ui.notify(committed ? "Sync complete: swept and pushed" : "Sync complete: no local changes, pulled and pushed", "info");
      } catch (e) {
        ctx.ui.notify(`Sync failed: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });

  // /dpi-save-status：查看保存状态（最近归档/推送/未推送数）
  registerDpiCommand(pi, "dpi-save-status", {
    description: "Show save status: last archive/push, unpushed commits",
    handler: async (_args, ctx) => {
      const cfg = loadConfig();
      const state = readSaveState();
      const pending = cfg.repoUrl ? await pendingCommits(cfg) : null;
      const lines = [
        formatSyncStatus(state, pending),
        remoteSyncLine(),
        state.lastArchive
          ? `Last archive: ${state.lastArchive.time.slice(0, 19).replace("T", " ")} ${state.lastArchive.session} (${state.lastArchive.result === "committed" ? "committed" : "copied"})`
          : "Last archive: none",
        state.lastPush
          ? `Last push: ${state.lastPush.time.slice(0, 19).replace("T", " ")} ${state.lastPush.result === "ok" ? "ok" : `failed${state.lastPush.error ? ` (${state.lastPush.error})` : ""}`}`
          : "Last push: none",
        pending !== null ? `Unpushed commits: ${pending}` : "Unpushed commits: unknown (git unavailable)",
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
