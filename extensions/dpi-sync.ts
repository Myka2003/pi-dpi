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
import { join } from "node:path";
import { hasToken, loadConfig, remoteNeedsToken, tokenPath } from "../src/config.ts";
import { GIT_TIMEOUT, gitIn } from "../src/git.ts";
import type { GitOptions } from "../src/git.ts";
import { registerDpiCommand } from "../src/command-alias.ts";
import {
  formatSyncStatus,
  pendingCommits,
  readSaveState,
  writeSaveState,
} from "../src/save-state.ts";

interface SyncTarget {
  repoPath: string;
  opts: GitOptions;
}

/** 同步前提检查：已绑定 + 需要令牌的类型已登录 + 本地仓库存在；不满足返回 null */
function target(): SyncTarget | null {
  const cfg = loadConfig();
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
          ctx.ui.notify(`⚠ ${pending} 个提交未推送（内容仓库），退出时自动重试`, "warning");
        }
      }
    } catch {
      // 绝不阻塞启动
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
    description: "手动同步内容仓库：pull --rebase → 清扫提交 → push；声明变更自动重载",
    handler: async (_args, ctx) => {
      const t = target();
      if (!t) {
        ctx.ui.notify("未绑定内容仓库或未登录，请先 /agent-login", "warning");
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
          ctx.ui.notify("同步完成：agent.json 已更新，自动重载生效…", "info");
          await ctx.reload();
          return;
        }
        ctx.ui.notify(committed ? "同步完成：已清扫提交并推送" : "同步完成：无本地改动，已拉取并推送", "info");
      } catch (e) {
        ctx.ui.notify(`同步失败: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });

  // /dpi-save-status：查看保存状态（最近归档/推送/未推送数）
  registerDpiCommand(pi, "dpi-save-status", {
    description: "查看保存状态：最近归档/推送、未推送提交数",
    handler: async (_args, ctx) => {
      const cfg = loadConfig();
      const state = readSaveState();
      const pending = cfg.repoUrl ? await pendingCommits(cfg) : null;
      const lines = [
        formatSyncStatus(state, pending),
        state.lastArchive
          ? `最近归档: ${state.lastArchive.time.slice(0, 19).replace("T", " ")} ${state.lastArchive.session}（${state.lastArchive.result === "committed" ? "已提交" : "仅复制"}）`
          : "最近归档: 无记录",
        state.lastPush
          ? `最近推送: ${state.lastPush.time.slice(0, 19).replace("T", " ")} ${state.lastPush.result === "ok" ? "成功" : `失败${state.lastPush.error ? `（${state.lastPush.error}）` : ""}`}`
          : "最近推送: 无记录",
        pending !== null ? `未推送提交: ${pending}` : "未推送提交: 未知（git 不可用）",
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
