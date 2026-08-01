/**
 * save-state：保存状态追踪（让用户能确认「退出时会话存上了」）。
 *
 * 会话保存分三层：(1) pi 实时写本地 JSONL（消息级，pi 保证）；
 * (2) session_shutdown 归档进仓库并 commit（session-vcs）；
 * (3) push 到远端（dpi-sync）。(2)(3) 是静默后台操作，本模块把结果
 * 落盘到 <dpiDir>/save-state.json，供面板指示（agent 卡片 Sync 段 +
 * 底栏状态）与 /dpi-save-status 查询展示。
 *
 * 本文件不放 extensions/（pi 会把每个 .ts 当扩展入口，无 default 导出会报错）。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dpiDir, type DpiConfig } from "./config.ts";
import { gitIn } from "./git.ts";
import { relTime } from "./sessions-shared.ts";

export interface SaveState {
  /** 最近一次会话归档（session_shutdown 时写入） */
  lastArchive?: {
    time: string; // ISO
    session: string; // 归档文件名
    result: "committed" | "copied"; // committed=已 git 提交；copied=仅复制（record off）
    blob: string; // 本机最后归档的 blob hash（分叉检测：与远端对比）
  };
  /** 最近一次推送（dpi-sync 写入） */
  lastPush?: {
    time: string; // ISO
    result: "ok" | "failed";
    error?: string;
  };
}

export function saveStatePath(): string {
  return join(dpiDir(), "save-state.json");
}

/** 读取状态；文件缺失/损坏回退 {}，绝不抛异常 */
export function readSaveState(): SaveState {
  try {
    if (!existsSync(saveStatePath())) return {};
    const raw = JSON.parse(readFileSync(saveStatePath(), "utf-8")) as SaveState;
    if (raw && typeof raw === "object") return raw;
    return {};
  } catch {
    return {};
  }
}

/** 合并写回状态文件（0600） */
export function writeSaveState(patch: Partial<SaveState>): void {
  try {
    const next = { ...readSaveState(), ...patch };
    const dir = dpiDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(saveStatePath(), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    try {
      chmodSync(saveStatePath(), 0o600);
    } catch {
      // 兜底失败不致命
    }
  } catch {
    // 状态写入失败静默（不影响保存流程本身）
  }
}

/** 未推送提交数（origin/<branch>..HEAD）；本地仓库无 origin 或 git 失败返回 null */
export async function pendingCommits(cfg: DpiConfig): Promise<number | null> {
  try {
    const branch = cfg.branch || "main";
    const { stdout } = await gitIn(
      cfg.repoPath,
      ["rev-list", "--count", `origin/${branch}..HEAD`],
      { noAuth: true, timeoutMs: 8000 },
    );
    const n = parseInt(stdout.trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** 面板状态文案：✓ 已同步 / ⚠ N 个未推送 / ✗ 上次推送失败 / … 尚无记录 */
export function formatSyncStatus(state: SaveState, pending: number | null): string {
  if (state.lastPush?.result === "failed") {
    return `✗ Last push failed (${relTime(Date.parse(state.lastPush.time) || 0)})`;
  }
  if (pending !== null && pending > 0) {
    return `⚠ ${pending} unpushed`;
  }
  if (state.lastPush?.result === "ok" && pending === 0) {
    return `✓ Synced ${relTime(Date.parse(state.lastPush.time) || 0)}`;
  }
  return "… no save record yet";
}

/** 底栏短状态：sync: ✓ / sync: ⚠3 / sync: ✗ / sync: ? */
export function syncStatusShort(state: SaveState, pending: number | null): string {
  if (state.lastPush?.result === "failed") return "sync: ✗";
  if (pending !== null && pending > 0) return `sync: ⚠${pending}`;
  if (state.lastPush?.result === "ok" && pending === 0) return "sync: ✓";
  return "sync: ?";
}

// ---------- 远端同步实时状态（进程内共享） ----------
// dpi-sync 的 3 秒监听定时器每轮写入，agent-loader 面板读——
// 让用户能在 Sync 栏直接看到「远端检测/拉取」的具体结果。

export interface RemoteSyncState {
  /** 最近一次远端检测（fetch）时间戳 ms */
  lastCheck: number;
  /** 最近一次检测结果 */
  lastResult: "" | "ok" | "failed";
  /** 最近一次成功拉取（pull）时间戳 ms；0 = 从未 */
  lastPull: number;
  /** 拉取进行中（面板显示 ⟳） */
  pulling: boolean;
}

export const remoteSyncState: RemoteSyncState = {
  lastCheck: 0,
  lastResult: "",
  lastPull: 0,
  pulling: false,
};

/** 远端同步状态的单行展示（面板 Sync 段用） */
export function remoteSyncLine(): string {
  const s = remoteSyncState;
  if (s.pulling) return "⟳ syncing remote…";
  if (s.lastCheck === 0) return "Remote: not checked (sync timer not started, /dpi-reload)";
  const ago = relTime(s.lastCheck);
  if (s.lastResult === "failed") return `✗ Remote check failed (${ago})`;
  if (s.lastPull >= s.lastCheck - 1) return `Pulled remote changes (${ago})`;
  return `Remote in sync (${ago})`;
}

/** 保存详情（面板 Sync 段第二行）：最近归档/推送的具体信息 */
export function formatSyncDetail(state: SaveState): string {
  const parts: string[] = [];
  if (state.lastArchive) {
    const t = state.lastArchive.time.slice(5, 16).replace("T", " ");
    parts.push(`archive ${t} ${state.lastArchive.session.slice(0, 24)}${state.lastArchive.result === "committed" ? " ✓" : ""}`);
  }
  if (state.lastPush) {
    const t = state.lastPush.time.slice(5, 16).replace("T", " ");
    parts.push(`push ${t} ${state.lastPush.result === "ok" ? "✓" : `✗ ${state.lastPush.error ?? ""}`}`);
  }
  return parts.join("\n  ");
}
