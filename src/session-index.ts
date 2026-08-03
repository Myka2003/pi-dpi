/**
 * session-index：会话名字索引（稀疏存储模型的显示层）。
 *
 * 问题：sessions/ 不在工作区，名字在 blob 里——列表显示名字需要逐个拉
 * blob（慢），多机器各自缓存不共享。
 * 方案：仓库根维护 session-index.json（cone 模式根文件默认检出，随 git
 * 同步）——归档/改名/删除时更新，浏览时本地读索引直接显示名字。
 * 索引缺失的条目（老归档）回退文件名显示。
 *
 * 格式：{ "<sessions/<agent>/<file>.jsonl>": { "name": "..." }, ... }
 *
 * 本文件不放 extensions/（pi 会把每个 .ts 当扩展入口，无 default 导出会报错）。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SessionIndexEntry {
  name: string;
  /** 归档文件大小（字节）——归档时记录，列表直接显示，无需拉 blob */
  size?: number;
  /** 首条 user 消息摘要（列表标题回退）——归档时本地提取 */
  first?: string;
  /** 最后一条消息时间（毫秒）——列表显示会话最新更新时间 */
  updatedAt?: number;
}

export type SessionIndex = Record<string, SessionIndexEntry>;

/** 索引文件路径：仓库根（cone 模式根文件默认检出，随 git 同步） */
export function sessionIndexPath(repo: string): string {
  return join(repo, "session-index.json");
}

/** 读索引；缺失/损坏回退 {}，绝不抛异常 */
export function readSessionIndex(repo: string): SessionIndex {
  try {
    const file = sessionIndexPath(repo);
    if (!existsSync(file)) return {};
    const raw = JSON.parse(readFileSync(file, "utf-8")) as SessionIndex;
    if (raw && typeof raw === "object") return raw;
    return {};
  } catch {
    return {};
  }
}

/** 写回索引（整体覆写）；失败静默 */
export function writeSessionIndex(repo: string, index: SessionIndex): void {
  try {
    writeFileSync(sessionIndexPath(repo), `${JSON.stringify(index, null, 2)}\n`, "utf-8");
  } catch {
    // 写失败静默（显示层，不影响会话本身）
  }
}

/** 设置一个归档的名字（改名/归档时调用） */
export function setSessionNameInIndex(repo: string, path: string, name: string): void {
  const index = readSessionIndex(repo);
  if (name) {
    index[path] = { ...(index[path] ?? {}), name };
  } else {
    delete index[path];
  }
  writeSessionIndex(repo, index);
}

/** 记录归档元数据（大小 + 首条消息摘要；归档时本地提取，零 blob 拉取） */
export function setSessionMetaInIndex(
  repo: string,
  path: string,
  meta: { size: number; first?: string; updatedAt?: number },
): void {
  const index = readSessionIndex(repo);
  const prev = index[path];
  index[path] = {
    ...(prev ?? { name: "" }),
    size: meta.size,
    first: meta.first,
    ...(meta.updatedAt && meta.updatedAt > 0 ? { updatedAt: meta.updatedAt } : {}),
  };
  writeSessionIndex(repo, index);
}

/** 移除一个归档的索引条目（删除时调用） */
export function removeSessionFromIndex(repo: string, path: string): void {
  const index = readSessionIndex(repo);
  delete index[path];
  writeSessionIndex(repo, index);
}
