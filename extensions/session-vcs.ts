/**
 * session-vcs：会话落盘存档，按 agent 归档（移植自旧内容仓库 extensions/session-vcs.ts）。
 *
 * - session_shutdown：若 recordSessions 为 true，把 session JSONL 复制进
 *   内容仓库 sessions/<currentAgent>/ 目录，并立即 git add+commit（归档持久化
 *   不依赖与 dpi-sync 的相对执行顺序——pi 的 session_shutdown 按扩展加载顺序
 *   逐个 await，若 dpi-sync 先执行，本次归档要等下次启动才推；这里自提交后
 *   最坏情况只是延迟一个同步周期，不会丢归档）。push 仍留给 dpi-sync。
 * - session_start：一次性迁移旧平铺档——把 <repo>/sessions/ 直属的 *.jsonl
 *   移入 sessions/_legacy/（renameSync，幂等；目录不存在跳过，单个失败容错继续）
 * - /record on|off|status：存档开关，写入 dpi 配置
 *
 * 会话自愈（坏消息清理）：
 * 网关 400/429 失败或用户中断（abort）时，pi 会把 content: [] 的空 assistant
 * 消息写入会话文件；此后每次请求都带上它，Anthropic 协议拒绝空消息 → 之后
 * 每一轮都 400，会话"死亡"。这里在两个时机自动清理：
 * - session_shutdown（quit）：归档前清理当前会话文件，归档进仓库的也是干净版
 * - session_start（new/resume/fork）：清理被替换下去的 previousSessionFile
 * 另有 /session-repair 手动修复当前会话（修的是磁盘文件，重进会话生效）。
 *
 * 未绑定内容仓库时静默跳过。agent 名 /^[\w-]+$/ 白名单校验防路径穿越，非法
 * 回退 _unknown；全部容错，绝不抛异常阻断 pi。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { gitAuthOpts, loadConfig, saveConfig } from "../src/config.ts";
import { gitHashObject, gitIn, gitUpdateIndexCacheInfo } from "../src/git.ts";
import { writeSaveState } from "../src/save-state.ts";
import { setSessionNameInIndex } from "../src/session-index.ts";
import { registerDpiCommand } from "../src/command-alias.ts";

/**
 * 清理会话文件中的空 assistant 坏消息（content: []），有改动才写回。
 * 返回删除条数；文件缺失/损坏/无坏消息返回 0，绝不抛异常。
 * 判定不看 stopReason：正常 assistant 消息不会有空 content，空即坏消息。
 * 导出供单元测试。
 */
export function repairSessionFile(file: string): number {
  try {
    if (!file || !existsSync(file)) return 0;
    const lines = readFileSync(file, "utf-8").split("\n");
    const kept: string[] = [];
    let removed = 0;
    for (const ln of lines) {
      if (ln.trim() === "") {
        kept.push(ln);
        continue;
      }
      let entry: { type?: string; message?: { role?: string; content?: unknown } };
      try {
        entry = JSON.parse(ln) as typeof entry;
      } catch {
        kept.push(ln); // 无法解析的行原样保留，绝不误删
        continue;
      }
      const msg = entry.message;
      if (
        entry.type === "message" &&
        msg?.role === "assistant" &&
        Array.isArray(msg.content) &&
        msg.content.length === 0
      ) {
        removed += 1;
        continue;
      }
      kept.push(ln);
    }
    if (removed > 0) writeFileSync(file, kept.join("\n"), "utf-8");
    return removed;
  } catch {
    return 0; // 修复失败不阻断任何流程
  }
}

// 存档根目录 <repo>/sessions：未绑定内容仓库时返回 null
function sessionsRoot(): string | null {
  const cfg = loadConfig();
  return cfg.repoUrl ? join(cfg.repoPath, "sessions") : null;
}

// 当前 agent 的存档子目录名（白名单校验，非法回退 _unknown）
function archiveAgentName(): string {
  const { currentAgent } = loadConfig();
  return /^[\w-]+$/.test(currentAgent) ? currentAgent : "_unknown";
}

/** 一次性迁移：sessions/ 直属的平铺 *.jsonl → sessions/_legacy/（幂等，逐步容错） */
function migrateLegacySessions(root: string): void {
  try {
    if (!existsSync(root)) return; // 存档目录不存在：跳过
    const flat = readdirSync(root, { withFileTypes: true }).filter(
      (e) => e.isFile() && e.name.endsWith(".jsonl"),
    );
    if (flat.length === 0) return;
    const legacy = join(root, "_legacy");
    mkdirSync(legacy, { recursive: true });
    for (const e of flat) {
      try {
        renameSync(join(root, e.name), join(legacy, e.name));
      } catch {
        // 单个失败容错继续（下次 session_start 再迁）
      }
    }
  } catch {
    // 迁移失败不阻断会话启动
  }
}

export default function (pi: ExtensionAPI) {
  // 定时归档：会话开着也每 15 分钟归档一次（人们不会频繁退出会话，退出时归档
  // 等于长期不同步）。复用 recordSessions 开关；启动时立即补归档一次（上次未归档的）。
  // 归档 = hash-object + update-index 直写 git（sessions/ 不在工作区）+ commit + push。
  const ARCHIVE_INTERVAL = 15 * 60 * 1000;
  let lastArchivedKey = ""; // 会话文件 mtime:size，避免空归档
  let archiveTimer: ReturnType<typeof setInterval> | null = null;

  async function archiveSession(
    ctx: ExtensionContext,
    opts: { force?: boolean; name?: string } = {},
  ): Promise<void> {
    try {
      const file = ctx.sessionManager.getSessionFile();
      const cfg = loadConfig();
      if (!cfg.recordSessions) return;
      if (!file || !existsSync(file)) return;
      const st = statSync(file);
      const key = `${st.mtimeMs}:${st.size}`;
      if (!opts.force && key === lastArchivedKey) return; // 定时路径：无变化不空提交
      repairSessionFile(file);
      const relPath = `sessions/${archiveAgentName()}/${basename(file)}`;
      let blob: string;
      if (opts.name) {
        // 主动命名保存：内容追加 session_info（临时文件写入后 hash）
        const content = `${readFileSync(file, "utf-8")}${JSON.stringify({ type: "session_info", name: opts.name })}\n`;
        const tmp = join(cfg.repoPath, ".git", `save-${Date.now()}.tmp`);
        writeFileSync(tmp, content, "utf-8");
        blob = await gitHashObject(cfg.repoPath, tmp, { noAuth: true, timeoutMs: 8000 });
        try {
          unlinkSync(tmp);
        } catch {
          // 清理失败静默
        }
      } else {
        blob = await gitHashObject(cfg.repoPath, file, { noAuth: true, timeoutMs: 8000 });
      }
      await gitUpdateIndexCacheInfo(cfg.repoPath, relPath, blob, {
        noAuth: true,
        timeoutMs: 8000,
      });
      if (opts.name) setSessionNameInIndex(cfg.repoPath, relPath, opts.name); // 名字索引同步
      await gitIn(cfg.repoPath, ["add", "session-index.json"], { noAuth: true, timeoutMs: 8000 });
      await gitIn(
        cfg.repoPath,
        ["commit", "-m", opts.name ? `save session ${opts.name}` : "[sync] archive session"],
        { noAuth: true, timeoutMs: 8000 },
      );
      try {
        await gitIn(cfg.repoPath, ["push"], gitAuthOpts(15000)); // 推送（私有仓库带 token）
      } catch {
        // push 失败静默（下次归档/启动补推）
      }
      try {
        await gitIn(cfg.repoPath, ["gc", "--auto"], { noAuth: true, timeoutMs: 8000 }); // 轻量 gc（阈值内 no-op）
      } catch {
        // gc 失败静默
      }
      lastArchivedKey = key;
      writeSaveState({
        lastArchive: {
          time: new Date().toISOString(),
          session: basename(file),
          result: "committed",
        },
      });
    } catch {
      // 归档失败静默（下个周期重试）
    }
  }

  pi.on("session_start", async (event, ctx) => {
    try {
      if (event.previousSessionFile) repairSessionFile(event.previousSessionFile);
    } catch {
      // 自愈失败静默
    }
    const root = sessionsRoot();
    if (!root) return;
    migrateLegacySessions(root);
    // 启动定时归档：立即一次（补上次未归档）+ 每 15 分钟
    if (archiveTimer) clearInterval(archiveTimer);
    lastArchivedKey = "";
    void archiveSession(ctx);
    archiveTimer = setInterval(() => void archiveSession(ctx), ARCHIVE_INTERVAL);
  });

  pi.on("session_shutdown", () => {
    if (archiveTimer) {
      clearInterval(archiveTimer);
      archiveTimer = null;
    }
  });

  registerDpiCommand(pi, "dpi-session-repair", {
    description: "Repair session file: clean empty assistant messages (400/429/abort leftovers)",
    handler: async (_args, ctx) => {
      try {
        const file = ctx.sessionManager.getSessionFile();
        if (!file) {
          ctx.ui.notify("No session file to repair", "warning");
          return;
        }
        const removed = repairSessionFile(file);
        ctx.ui.notify(
          removed > 0
            ? `Cleaned ${removed} bad messages. Current session memory still holds them; exit and resume to apply`
            : "Session file healthy, nothing to repair",
          "info",
        );
      } catch (e) {
        ctx.ui.notify(`Repair failed: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });

  // /dpi-save：主动存档（Ctrl+S 式）——立即保存当前会话，带参数即命名保存点
  registerDpiCommand(pi, "dpi-save", {
    description: "Save current session to archive now; with a name = named savepoint",
    handler: async (args, ctx) => {
      const name = (args ?? "").trim();
      await archiveSession(ctx, { force: true, name: name || undefined });
      ctx.ui.notify(name ? `Saved: ${name}` : "Session saved", "info");
    },
  });

  registerDpiCommand(pi, "dpi-record", {
    description: "Session archive toggle: /dpi-record on|off|status",
    handler: async (args, ctx) => {
      const sub = (args ?? "").trim().toLowerCase();
      if (sub === "on" || sub === "off") {
        saveConfig({ recordSessions: sub === "on" });
        ctx.ui.notify(`Session archiving ${sub === "on" ? "enabled" : "disabled"}`, "info");
        return;
      }
      if (sub === "status" || sub === "") {
        ctx.ui.notify(
          `Session archiving: ${loadConfig().recordSessions ? "on" : "off"}`,
          "info",
        );
        return;
      }
      ctx.ui.notify("Usage: /dpi-record on|off|status", "warning");
    },
  });
}
