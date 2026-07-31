/**
 * session-browser：/sessions 浏览并恢复仓库存档会话（session-vcs 的读取侧）。
 *
 * - 扫描 <repo>/sessions/ 下各 agent 子目录（目录名即 agent 名，含 _legacy
 *   迁移区，/^[\w-]+$/ 白名单校验），解析与标题格式见 src/sessions-shared.ts
 *   （固定格式「MM-DD 目录 · 首条消息」+ 分页展示）
 * - 选择用 vim 风格自定义组件（src/session-picker.ts）：j/k 导航、gg/G 首末页、
 *   PgUp/PgDn 翻页、/ 过滤、c 切换 agent 筛选——取代 ctx.ui.select
 *   （不支持滚动，条目多时撑爆终端）
 * - 选中会话 → 子菜单（标题 会话 — <name ?? 日期>）：「↩ 恢复到本机并切换」/
 *   「✕ 删除存档（git 可恢复）」/「← 返回」
 * - 恢复：复制进 ctx.sessionManager.getSessionDir()（同名已存在不覆盖，提示后
 *   直接切换），首行 header 的 cwd 改写为本机 getCwd()（只改首行，其余行原样），
 *   然后 ctx.switchSession()；切换失败提示已复制、请用 /resume
 * - 非 UI 环境只 notify 各 agent 存档计数摘要；存档总数为 0 时提示无存档
 *
 * 内容仓库路径来自 dpi 配置；未绑定时提示先 /agent-login。
 * 文件读写逐步容错，绝不抛异常阻断 pi。
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { errMsg } from "../src/common.ts";
import { entryLabel, scanArchived, type ArchivedSession } from "../src/sessions-shared.ts";
import { showSessionPicker } from "../src/session-picker.ts";

// 子菜单固定项
const RESTORE_ITEM = "↩ 恢复到本机并切换";
const DELETE_ITEM = "✕ 删除存档（git 可恢复）";
const BACK_ITEM = "← 返回";

/** 恢复：复制进本机会话目录（同名不覆盖）→ 改写首行 cwd → switchSession。返回是否已切换 */
async function restoreArchived(
  ctx: ExtensionCommandContext,
  s: ArchivedSession,
): Promise<boolean> {
  let dir = "";
  try {
    dir = ctx.sessionManager.getSessionDir();
  } catch {
    dir = "";
  }
  if (!dir) {
    ctx.ui.notify("恢复失败：拿不到本机会话目录，请手动复制存档后用 /resume", "error");
    return false;
  }
  const dest = join(dir, s.fileName);
  try {
    mkdirSync(dir, { recursive: true });
    if (!existsSync(dest)) {
      // 只改首行 header 的 cwd 为本机路径（避免 pi 在旧机器路径上跑），其余行原样
      const text = readFileSync(s.path, "utf-8");
      const nl = text.indexOf("\n");
      const head = nl < 0 ? text : text.slice(0, nl);
      const rest = nl < 0 ? "" : text.slice(nl);
      let out = text;
      try {
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
      ctx.ui.notify(`本机已存在同名会话 ${s.fileName}，将直接切换（不是远端版本）`, "warning");
    }
  } catch (e) {
    ctx.ui.notify(`复制存档失败：${errMsg(e)}`, "error");
    return false;
  }
  try {
    await ctx.switchSession(dest);
  } catch {
    ctx.ui.notify(`已复制到本机会话目录，请用 /resume 恢复（${entryLabel(s)}）`, "info");
    return false;
  }
  ctx.ui.notify(`已恢复：${entryLabel(s)}`, "info");
  return true;
}

/** 删除：confirm 确认 → unlinkSync（git 可恢复）。返回是否已删除 */
async function deleteArchived(
  ctx: ExtensionCommandContext,
  s: ArchivedSession,
): Promise<boolean> {
  const ok = await ctx.ui.confirm("删除会话存档", "删除该会话存档（git 可恢复）。确认？");
  if (!ok) return false;
  try {
    unlinkSync(s.path);
  } catch (e) {
    ctx.ui.notify(`删除失败：${errMsg(e)}`, "error");
    return false;
  }
  ctx.ui.notify("已删除会话存档", "info");
  return true;
}

export default function (pi: ExtensionAPI) {
  // /sessions：浏览仓库存档会话，一键恢复到本机并切换
  pi.registerCommand("sessions", {
    description: "浏览仓库存档会话（vim 导航：j/k、gg/G、/过滤），一键恢复到本机并切换",
    handler: async (_args, ctx) => {
      const cfg = loadConfig();
      if (!cfg.repoUrl) {
        ctx.ui.notify("未绑定内容仓库，请先 /agent-login", "warning");
        return;
      }
      const repo = cfg.repoPath;
      // 配置文件可被手工编辑，防御路径穿越：agent 名只允许纯目录名
      const agent = /^[\w-]+$/.test(cfg.currentAgent) ? cfg.currentAgent : "coder";

      const archived = scanArchived(repo);
      if (archived.length === 0) {
        ctx.ui.notify("仓库中还没有会话存档（/record on 后按 agent 自动归档）", "info");
        return;
      }

      if (!ctx.hasUI) {
        // 非 UI：只给各 agent 存档计数摘要
        const counts = new Map<string, number>();
        for (const s of archived) counts.set(s.agent, (counts.get(s.agent) ?? 0) + 1);
        const lines = [...counts.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([a, n]) => `${a}: ${n} 个`);
        ctx.ui.notify(`会话存档（共 ${archived.length} 个）\n${lines.join("\n")}`, "info");
        return;
      }

      // vim 风格选择器（含分页/过滤/agent 筛选）；选中后走恢复/删除子菜单
      let archivedNow = archived;
      for (;;) {
        const picked = await showSessionPicker(ctx, archivedNow, agent);
        if (!picked) return; // 取消/完成
        const action = await ctx.ui.select(`会话 — ${entryLabel(picked)}`, [
          RESTORE_ITEM,
          DELETE_ITEM,
          BACK_ITEM,
        ]);
        if (action === RESTORE_ITEM) {
          if (await restoreArchived(ctx, picked)) return; // 已切换会话：结束命令
          continue;
        }
        if (action === DELETE_ITEM) {
          if (await deleteArchived(ctx, picked)) {
            archivedNow = scanArchived(repo); // 重扫刷新，支持连续删除
            if (archivedNow.length === 0) return;
          }
          continue;
        }
        // BACK_ITEM / 取消：回到选择器
      }
    },
  });
}
