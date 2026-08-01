/**
 * sessions-shared：会话存档的解析与展示辅助（session-browser 与 session-picker 共用）。
 *
 * 本文件不放 extensions/（pi 会把每个 .ts 当扩展入口，无 default 导出会报错）。
 */
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";

// >2MB 的存档只读头部 256KB（header 与首条消息都在头部），按文件名展示
const BIG_FILE_BYTES = 2 * 1024 * 1024;
const HEAD_BYTES = 256 * 1024;

export interface ArchivedSession {
  agent: string; // sessions/ 下目录名（含 _legacy）
  path: string; // 存档文件绝对路径
  fileName: string; // basename（恢复时作目标文件名）
  name: string; // 最新 session_info.name；无则 ""
  firstUser: string; // 首条非 meta user 消息文本（已清洗压缩）
  messages: number; // user+assistant 消息数
  sortKey: number; // 排序键：最后 user/assistant 消息时间戳（ms），回退 header.timestamp
  dayLabel: string; // header.timestamp 的 YYYY-MM-DD（标题/通知的日期回退）
  cwdLabel: string; // header.cwd 最后一段（标题格式用），空串回退 fileName
  partial: boolean; // >2MB 只解析了头部：按文件名展示、不计数
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** 消息 content 取首段文本：字符串直取，数组找第一个 {type:"text",text} */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const part of content) {
      const p = part as Record<string, unknown> | null;
      if (p && p.type === "text" && typeof p.text === "string") return p.text;
    }
  }
  return "";
}

/**
 * 首条消息清洗（固定格式标题用）：去掉 [Image #N] 图片占位、markdown 代码围栏、
 * 尖括号标签、长 URL，压缩空白。返回清洗后文本或空串。
 */
function cleanUserText(raw: string): string {
  return raw
    .replace(/\[Image #[0-9]+\]/g, "") // 图片占位
    .replace(/```[\s\S]*?```/g, "") // 代码块
    .replace(/<[^>]{2,200}>/g, " ") // 尖括号标记（local-command-caveat/skill 标签等）
    .replace(/https?:\/\/\S+/g, "") // 长 URL
    .replace(/\s+/g, " ")
    .trim();
}

/** 行时间戳（ms）：entry.timestamp（ISO 字符串）优先，回退 message.timestamp（epoch ms） */
function lineTimestamp(
  rec: Record<string, unknown>,
  msg: Record<string, unknown> | null,
): number {
  const ts = rec.timestamp;
  if (typeof ts === "string") {
    const t = Date.parse(ts);
    if (!Number.isNaN(t)) return t;
  }
  if (typeof ts === "number" && Number.isFinite(ts)) return ts;
  const inner = msg?.timestamp;
  if (typeof inner === "number" && Number.isFinite(inner)) return inner;
  return 0;
}

/** 解析单个存档 .jsonl；坏文件返回 null（调用方跳过）。
 * >2MB 的大文件读头尾各 256KB（头部拿 header/首条消息，尾部拿
 * session_info 名字与最后消息时间——名字在文件尾部，只读头会丢）。 */
export function parseArchived(agent: string, path: string): ArchivedSession | null {
  try {
    const partial = statSync(path).size > BIG_FILE_BYTES;
    let text: string;
    if (partial) {
      const fd = openSync(path, "r");
      try {
        const size = statSync(path).size;
        const buf = Buffer.alloc(HEAD_BYTES * 2);
        const n1 = readSync(fd, buf, 0, HEAD_BYTES, 0); // 头部：header/首条消息
        const tailStart = Math.max(0, size - HEAD_BYTES);
        let n2 = 0;
        if (tailStart >= n1) {
          n2 = readSync(fd, buf, HEAD_BYTES, HEAD_BYTES, tailStart); // 尾部：session_info/最后时间
        }
        text = buf.toString("utf-8", 0, n1 + n2);
      } finally {
        closeSync(fd);
      }
    } else {
      text = readFileSync(path, "utf-8");
    }
    const entry: ArchivedSession = {
      agent,
      path,
      fileName: basename(path),
      name: "",
      firstUser: "",
      messages: 0,
      sortKey: 0,
      dayLabel: "",
      cwdLabel: "",
      partial,
    };
    let parsedAny = false; // 是否解析出任何有效行（全坏行 = 坏文件，整体跳过）
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(t) as Record<string, unknown>;
      } catch {
        continue; // 坏行宽容跳过
      }
      if (rec.type === "session") {
        parsedAny = true;
        if (typeof rec.timestamp === "string") {
          const t0 = Date.parse(rec.timestamp);
          if (!Number.isNaN(t0) && entry.sortKey === 0) entry.sortKey = t0; // header 兜底
          if (!entry.dayLabel) entry.dayLabel = rec.timestamp.slice(0, 10);
        }
        if (typeof rec.cwd === "string" && rec.cwd !== "" && !entry.cwdLabel) {
          const parts = rec.cwd.split("/").filter(Boolean);
          entry.cwdLabel = parts.length > 0 ? parts[parts.length - 1] : rec.cwd;
        }
        continue;
      }
      if (rec.type === "session_info") {
        parsedAny = true;
        if (typeof rec.name === "string" && rec.name.trim() !== "") {
          entry.name = rec.name.trim(); // 流式覆盖：取最新一条
        }
        continue;
      }
      if (rec.type !== "message") continue;
      const msg = (rec.message ?? null) as Record<string, unknown> | null;
      if (!msg) continue;
      const role = msg.role;
      if (role !== "user" && role !== "assistant") continue;
      parsedAny = true;
      entry.messages++;
      // 首条真实用户消息（跳过 isMeta 系统注入，如 local-command-caveat）
      if (role === "user" && !entry.firstUser && !rec.isMeta) {
        entry.firstUser = cleanUserText(extractText(msg.content));
      }
      const ts = lineTimestamp(rec, msg);
      if (ts > 0) entry.sortKey = ts; // 流式覆盖：取最后一条
    }
    if (!parsedAny) return null; // 全坏行/空文件：坏文件跳过
    if (partial) {
      // 大文件：名字保留（尾部 session_info 已解析）、首条消息保留（头部）、
      // 计数丢弃（只读了头尾，消息数不完整会误导）
      entry.messages = 0;
    }
    return entry;
  } catch {
    return null;
  }
}

/** 扫描 <repo>/sessions/ 下各 agent 子目录（含 _legacy）的全部存档；目录不存在/读失败回退空 */
export function scanArchived(repo: string): ArchivedSession[] {
  try {
    const root = join(repo, "sessions");
    if (!existsSync(root)) return [];
    const out: ArchivedSession[] = [];
    for (const dir of readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory() || !/^[\w-]+$/.test(dir.name)) continue;
      let files: string[] = [];
      try {
        files = readdirSync(join(root, dir.name)).filter((f: string) => f.endsWith(".jsonl"));
      } catch {
        continue;
      }
      for (const f of files) {
        const parsed = parseArchived(dir.name, join(root, dir.name, f));
        if (parsed) out.push(parsed);
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** 相对时间：刚刚 / N分钟前 / N小时前 / N天前 / N个月前 / N年前 */
export function relTime(ms: number): string {
  if (ms <= 0) return "unknown";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

/** 列表条目标题：name ?? 固定格式「MM-DD 目录 · 首条消息」；partial 按文件名展示 */
export function entryTitle(s: ArchivedSession): string {
  // partial（大文件）：有名字显示名字，否则按文件名展示（首条消息可能缺）
  const pname = s.name.replace(/\s+/g, " ").trim();
  if (s.partial) return pname ? truncate(pname, 40) : s.fileName;
  const t = s.name.replace(/\s+/g, " ").trim();
  if (t) return truncate(t, 40);
  const day = s.dayLabel.slice(5); // YYYY-MM-DD → MM-DD
  const ctx = s.cwdLabel || "";
  const head = truncate(s.firstUser, 24);
  const parts = [day, ctx, head ? `· ${head}` : ""].filter(Boolean);
  return parts.join(" ") || truncate(s.fileName, 40);
}

/** 子菜单标题/通知用的短名：name ?? 日期 */
export function entryLabel(s: ArchivedSession): string {
  const t = s.name.replace(/\s+/g, " ").trim();
  return t || s.dayLabel || s.fileName;
}

// ---------- 稀疏存储模型：git 元数据扫描 + 名字懒加载 ----------

import { gitLsTree, gitShow } from "./git.ts";
import { readSessionIndex } from "./session-index.ts";
import { gitAuthOpts } from "./config.ts";

/** 从 JSONL 文本解析最新 session_info 名字（流式覆盖取最后一条） */
export function parseNameFromText(text: string): string {
  let name = "";
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t) as Record<string, unknown>;
      if (rec.type === "session_info" && typeof rec.name === "string" && rec.name.trim() !== "") {
        name = rec.name.trim();
      }
    } catch {
      // 坏行跳过
    }
  }
  return name;
}

export interface ArchivedMeta {
  agent: string;
  path: string; // 仓库相对路径 sessions/<agent>/<file>.jsonl
  fileName: string;
  sortKey: number;
  dayLabel: string;
  name: string; // 来自 session-index（多机器同步的名字），无则 ""
}

/** 文件名时间戳：2026-08-01T00-00-00-000Z_<uuid>.jsonl → Date.parse（连字符代替冒号） */
function metaFromFileName(fileName: string): { sortKey: number; dayLabel: string } {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)/.exec(fileName);
  if (!m) return { sortKey: 0, dayLabel: "" };
  const iso = m[1].replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "T$1:$2:$3.$4Z");
  const ts = Date.parse(iso);
  return { sortKey: Number.isNaN(ts) ? 0 : ts, dayLabel: m[1].slice(0, 10) };
}

/** 从 git 元数据列归档（不下载内容；sessions/ 不在工作区）；名字来自 session-index */
export async function scanArchivedMeta(repo: string): Promise<ArchivedMeta[]> {
  try {
    const entries = await gitLsTree(repo, "origin/main", "sessions", {
      noAuth: true,
      timeoutMs: 8000,
    });
    const index = readSessionIndex(repo);
    const out: ArchivedMeta[] = [];
    for (const e of entries) {
      const m = /^sessions\/([^/]+)\/([^/]+\.jsonl)$/.exec(e.path);
      if (!m) continue;
      const { sortKey, dayLabel } = metaFromFileName(m[2]);
      out.push({
        agent: m[1],
        path: e.path,
        fileName: m[2],
        sortKey,
        dayLabel,
        name: index[e.path]?.name ?? "",
      });
    }
    return out.sort((a, b) => b.sortKey - a.sortKey);
  } catch {
    return [];
  }
}

/** 懒加载单个归档的名字（git show 拉 blob 解析 session_info） */
export async function fetchArchivedName(repo: string, path: string): Promise<string> {
  try {
    const buf = await gitShow(repo, "origin/main", path, gitAuthOpts());
    return parseNameFromText(buf.toString("utf-8"));
  } catch {
    return "";
  }
}

/** 移除尾部非 message entry（session_info/session 等元数据）。
 * pi 以最后一条 entry 为会话树叶子——尾部元数据（改名/归档追加）导致
 * 恢复后上下文为空。名字在 session-index 不丢；header 在第一行不受影响。 */
export function stripTrailingNonMessage(text: string): string {
  const lines = text.split("\n").filter((l) => l.trim());
  while (lines.length > 0) {
    try {
      const last = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
      if (last.type === "message") break;
    } catch {
      break; // 坏行不处理
    }
    lines.pop();
  }
  return lines.join("\n") + "\n";
}

/** 恢复健壮化：一次扫描移除会导致 pi 加载/API 拒绝的结构（不改归档）：
 * 1. 孤儿 toolResult（compaction 摘要压掉前置 tool_calls 的消息——API 要求
 *    tool 消息必须在 tool_calls 之后，孤儿会 400 拒绝）
 * 2. 坏行（JSON 解析失败）
 * 3. 尾部非 message entry（pi 以最后一条为树叶子，元数据尾会导致空上下文）
 * 名字在 session-index 不丢；header 在第一行不受影响。 */
export function sanitizeSessionForRestore(text: string): string {
  const lines = text.split("\n").filter((l) => l.trim());
  const kept: string[] = [];
  const pendingToolCalls = new Set<string>();
  let lastRole = ""; // 上一条消息 role（连续 toolResult 检测）
  for (const line of lines) {
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // 坏行丢弃（pi 加载也会跳过）
    }
    // compaction 摘要：pi 按压缩段落构建上下文——段落之前的 tool_calls
    // 不在摘要后的上下文里，重置配对（段落内的 toolResult 独立配对）
    if (rec.type === "compaction") {
      pendingToolCalls.clear();
      kept.push(line);
      continue;
    }
    const msg = (rec.message ?? null) as Record<string, unknown> | null;
    const role = msg?.role;
    const content = msg?.content;
    if (role === "assistant" && Array.isArray(content)) {
      for (const part of content) {
        const pc = part as Record<string, unknown> | null;
        if (pc && pc.type === "toolCall" && typeof pc.id === "string") {
          pendingToolCalls.add(pc.id);
        }
      }
    }
    if (role === "toolResult") {
      // 连续 toolResult：API 要求 tool 消息紧跟 tool_calls，连续会 400——丢后一个
      if (lastRole === "toolResult") continue;
      const callId = (msg as { toolCallId?: unknown }).toolCallId;
      if (typeof callId === "string" && pendingToolCalls.has(callId)) {
        kept.push(line);
        pendingToolCalls.delete(callId);
      }
      // 孤儿 toolResult：丢弃（前置 tool_calls 已被 compaction 摘要压掉）
      lastRole = "toolResult";
      continue;
    }
    kept.push(line);
    if (typeof role === "string") lastRole = role;
  }
  // 尾部非 message（pi 树叶子）
  while (kept.length > 0) {
    try {
      const last = JSON.parse(kept[kept.length - 1]) as Record<string, unknown>;
      if (last.type === "message") break;
    } catch {
      break;
    }
    kept.pop();
  }
  return kept.join("\n") + "\n";
}
