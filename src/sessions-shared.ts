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

/** 解析单个存档 .jsonl；坏文件返回 null（调用方跳过） */
export function parseArchived(agent: string, path: string): ArchivedSession | null {
  try {
    const partial = statSync(path).size > BIG_FILE_BYTES;
    let text: string;
    if (partial) {
      const fd = openSync(path, "r");
      try {
        const buf = Buffer.alloc(HEAD_BYTES);
        const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
        text = buf.toString("utf-8", 0, n);
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
      // 大文件按文件名展示：头部解析出的名字/计数会误导，丢弃
      entry.name = "";
      entry.firstUser = "";
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
  if (ms <= 0) return "时间未知";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "刚刚";
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min}分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}天前`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}个月前`;
  return `${Math.floor(mo / 12)}年前`;
}

/** 列表条目标题：name ?? 固定格式「MM-DD 目录 · 首条消息」；partial 按文件名展示 */
export function entryTitle(s: ArchivedSession): string {
  if (s.partial) return s.fileName;
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
