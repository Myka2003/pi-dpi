/**
 * session-browser：/dpi-sessions 浏览并恢复仓库存档会话（session-vcs 的读取侧）。
 *
 * 稀疏存储模型（spec: 2026-08-01-session-storage-model-design.md）：
 * sessions/ 不在本地工作区——浏览用 git 元数据（scanArchivedMeta，ls-tree），
 * 恢复/重命名/删除按需操作 git 对象库（show/hash-object/update-index）。
 * 纯在线：操作前兜底 fetch 一次（3 秒监听已维护 origin/main 最新）。
 *
 * - 列表：`[agent] 文件名 · 大小`（vim 选择器），选中后懒加载名字（gitShow 单文件）
 * - 子菜单：恢复（gitShow → 本机会话目录，改写 cwd header）/ 重命名 / 删除
 * - 非 UI 环境只 notify 各 agent 存档计数摘要；存档总数为 0 时提示无存档
 *
 * 内容仓库路径来自 dpi 配置；未绑定时提示先 /dpi-agent-login。
 * 全部容错：git 操作失败 notify 错误，绝不抛异常阻断 pi。
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, remoteNeedsToken, tokenPath } from "../src/config.ts";
import { errMsg } from "../src/common.ts";
import { gitIn } from "../src/git.ts";
import {
  gitHashObject,
  gitIndexRemove,
  gitShow,
  gitUpdateIndexCacheInfo,
} from "../src/git.ts";
import {
  fetchArchivedName,
  scanArchivedMeta,
  type ArchivedMeta,
} from "../src/sessions-shared.ts";
import { removeSessionFromIndex, setSessionNameInIndex } from "../src/session-index.ts";
import { showSessionPicker } from "../src/session-picker.ts";
import { registerDpiCommand } from "../src/command-alias.ts";

// 子菜单固定项
const RESTORE_ITEM = "↩ Restore to this machine and switch";
const RENAME_ITEM = "✏ Rename";
const DELETE_ITEM = "✕ Delete archive (git recoverable)";
const BACK_ITEM = "← Back";

/** 本地 git 操作 opts（noAuth：本地对象操作零凭证） */
function gitOpts() {
  return { noAuth: true, timeoutMs: 8000 };
}

/** push 需要远端认证（私有仓库）——从 dpi 配置取 token/proxy */
function gitPushOpts() {
  const cfg = loadConfig();
  return remoteNeedsToken(cfg.remoteKind)
    ? { tokenFile: tokenPath(), proxy: cfg.proxy, timeoutMs: 15000 }
    : { noAuth: true, timeoutMs: 15000 };
}

/** 恢复：gitShow 拉 blob → 本机会话目录（改写 cwd header）→ switchSession。返回是否已切换 */
async function restoreArchived(
  ctx: ExtensionCommandContext,
  s: ArchivedMeta,
): Promise<boolean> {
  let dir = "";
  try {
    dir = ctx.sessionManager.getSessionDir();
  } catch {
    dir = "";
  }
  if (!dir) {
    ctx.ui.notify("Restore failed: cannot get local session dir, copy manually and /resume", "error");
    return false;
  }
  const repo = loadConfig().repoPath;
  const dest = join(dir, s.fileName);
  try {
    mkdirSync(dir, { recursive: true });
    if (!existsSync(dest)) {
      // 按需拉 blob（sessions/ 不在工作区）
      const buf = await gitShow(repo, "origin/main", s.path, gitOpts());
      let out = buf.toString("utf-8");
      // 只改首行 header 的 cwd 为本机路径（避免 pi 在旧机器路径上跑），其余行原样
      try {
        const nl = out.indexOf("\n");
        const head = nl < 0 ? out : out.slice(0, nl);
        const rest = nl < 0 ? "" : out.slice(nl);
        const header = JSON.parse(head) as Record<string, unknown>;
        if (header.type === "session") {
          const cwd = ctx.sessionManager.getCwd();
          if (cwd) header.cwd = cwd;
          out = `${JSON.stringify(header)}${rest}`;
        }
      } catch {
        // 首行损坏/取 cwd 失败：原样写入
      }
      writeFileSync(dest, out, "utf-8");
    } else {
      // 本机已有同名文件：不覆盖，直接切换（提示避免误以为恢复了远端版本）
      ctx.ui.notify(`Local session ${s.fileName} already exists, switching to it (not the archived copy)`, "warning");
    }
  } catch (e) {
    ctx.ui.notify(`Restore failed (needs network): ${errMsg(e)}`, "error");
    return false;
  }
  try {
    await ctx.switchSession(dest);
  } catch {
    ctx.ui.notify(`Copied to local sessions, use /resume (${s.fileName})`, "info");
    return false;
  }
  ctx.ui.notify(`Restored: ${s.fileName}`, "info");
  return true;
}

/** 重命名：gitShow 拉内容 → 追加 session_info → hash-object + update-index + commit。 */
async function renameArchived(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  s: ArchivedMeta,
): Promise<boolean> {
  const name = ((await ctx.ui.input("Session name (empty to cancel)", s.fileName)) ?? "").trim();
  if (!name) return false;
  const repo = loadConfig().repoPath;
  try {
    // 追加 session_info（流式覆盖）→ 直写 git（sessions/ 不在工作区）
    const buf = await gitShow(repo, "origin/main", s.path, gitOpts());
    const record = { type: "session_info", name };
    const updated = `${buf.toString("utf-8")}${JSON.stringify(record)}\n`;
    const tmp = join(repo, ".git", `rename-${s.fileName}.tmp`);
    writeFileSync(tmp, updated, "utf-8");
    const blob = await gitHashObject(repo, tmp, gitOpts());
    await gitUpdateIndexCacheInfo(repo, s.path, blob, gitOpts());
    setSessionNameInIndex(repo, s.path, name); // 索引同步（随 git 跨机器）
    await gitIn(repo, ["add", "session-index.json"], gitOpts());
    await gitIn(repo, ["commit", "-m", `rename session ${s.fileName}`], gitOpts());
    // 推送（带认证；失败静默，下次同步补）
    try {
      await gitIn(repo, ["push"], gitPushOpts());
    } catch {
      // push 失败不阻断（内容已本地提交）
    }
    // 当前会话的归档：联动改本机会话名（立即生效 + 触发 session_info_changed 重绘卡片）
    let isCurrent = false;
    try {
      const cur = ctx.sessionManager.getSessionFile() ?? "";
      isCurrent = cur.split("/").pop() === s.fileName;
    } catch {
      isCurrent = false;
    }
    if (isCurrent) {
      try {
        pi.setSessionName(name);
        ctx.ui.notify(`Renamed to: ${name} (current session)`, "info");
        return true;
      } catch {
        // setSessionName 失败不阻断归档改名
      }
    }
  } catch (e) {
    ctx.ui.notify(`Rename failed (needs network): ${errMsg(e)}`, "error");
    return false;
  }
  ctx.ui.notify(`Renamed to: ${name}`, "info");
  return true;
}

/** 删除：git update-index --force-remove + commit（git 历史可恢复） */
async function deleteArchived(
  ctx: ExtensionCommandContext,
  s: ArchivedMeta,
): Promise<boolean> {
  const ok = await ctx.ui.confirm("Delete session archive", "Delete this archive (git recoverable). Confirm?");
  if (!ok) return false;
  const repo = loadConfig().repoPath;
  try {
    await gitIndexRemove(repo, s.path, gitOpts());
    removeSessionFromIndex(repo, s.path); // 索引同步（随 git 跨机器）
    await gitIn(repo, ["add", "session-index.json"], gitOpts());
    await gitIn(repo, ["commit", "-m", `delete session ${s.fileName}`], gitOpts());
    try {
      await gitIn(repo, ["push"], gitPushOpts());
    } catch {
      // push 失败静默
    }
  } catch (e) {
    ctx.ui.notify(`Delete failed: ${errMsg(e)}`, "error");
    return false;
  }
  ctx.ui.notify("Archive deleted", "info");
  return true;
}

export default function (pi: ExtensionAPI) {
  // /dpi-sessions：浏览仓库存档会话（git 元数据），一键恢复到本机并切换
  registerDpiCommand(pi, "dpi-sessions", {
    description: "Browse archived sessions (vim nav: j/k, gg/G, / filter), restore and switch",
    handler: async (_args, ctx) => {
      const cfg = loadConfig();
      if (!cfg.repoUrl) {
        ctx.ui.notify("No content repo bound, run /dpi-agent-login first", "warning");
        return;
      }
      const repo = cfg.repoPath;
      const agent = /^[\w-]+$/.test(cfg.currentAgent) ? cfg.currentAgent : "coder";

      // 纯在线：先兜底 fetch 一次（3 秒监听已维护 origin/main，这里确保打开时最新）
      try {
        await gitIn(repo, ["fetch", "origin"], { noAuth: true, timeoutMs: 8000 });
      } catch {
        // fetch 失败：可能离线，列表用上次 origin/main 状态
      }

      const archived = await scanArchivedMeta(repo);
      if (archived.length === 0) {
        ctx.ui.notify("No archived sessions yet (/dpi-record on archives on exit)", "info");
        return;
      }

      if (!ctx.hasUI) {
        // 非 UI：只给各 agent 存档计数摘要
        const counts = new Map<string, number>();
        for (const s of archived) counts.set(s.agent, (counts.get(s.agent) ?? 0) + 1);
        const lines = [...counts.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([a, n]) => `${a}: ${n}`);
        ctx.ui.notify(`Session archives (${archived.length} total)\n${lines.join("\n")}`, "info");
        return;
      }

      // vim 风格选择器（c 键切换 agent 筛选）；选中后懒加载名字 + 操作子菜单
      let archivedNow = archived;
      let onlyCurrent = false;
      for (;;) {
        const picked = await showSessionPicker(ctx, archivedNow, agent, onlyCurrent);
        if (picked === "cycle-filter") {
          onlyCurrent = !onlyCurrent;
          continue;
        }
        if (!picked) return; // 取消/完成
        // 名字：索引有直接用；索引没有才懒加载（拉 blob 解析）并写回索引
        let name = picked.name;
        if (!name) {
          const fetched = await fetchArchivedName(repo, picked.path);
          if (fetched) {
            name = fetched;
            setSessionNameInIndex(repo, picked.path, fetched); // 写回索引（后续列表直接显示）
          }
        }
        name = name || picked.fileName;
        const action = await ctx.ui.select(`Session — ${name}`, [
          RESTORE_ITEM,
          RENAME_ITEM,
          DELETE_ITEM,
          BACK_ITEM,
        ]);
        if (action === RESTORE_ITEM) {
          if (await restoreArchived(ctx, picked)) return; // 已切换会话：结束命令
          continue;
        }
        if (action === RENAME_ITEM) {
          if (await renameArchived(pi, ctx, picked)) {
            archivedNow = await scanArchivedMeta(repo); // 重扫刷新列表
            if (archivedNow.length === 0) return;
          }
          continue;
        }
        if (action === DELETE_ITEM) {
          if (await deleteArchived(ctx, picked)) {
            archivedNow = await scanArchivedMeta(repo); // 重扫刷新，支持连续删除
            if (archivedNow.length === 0) return;
          }
          continue;
        }
        // BACK_ITEM / 取消：回到选择器
      }
    },
  });
}
