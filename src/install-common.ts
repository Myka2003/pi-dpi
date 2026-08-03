/**
 * install-common：一键安装共用的仓库提交/推送辅助（skill/扩展安装共用）。
 *
 * 本文件不放 extensions/（pi 会把每个 .ts 当扩展入口，无 default 导出会报错）。
 */
import { gitAuthOpts } from "./config.ts";
import { gitIn } from "./git.ts";

/** 目录/文件名白名单（防路径穿越） */
export function safeName(name: string): boolean {
  return /^[\w-]+$/.test(name);
}

/** add -A + commit + push；push 失败（离线/拒绝）返回 false 不抛 */
export async function commitAndPush(repo: string, message: string): Promise<boolean> {
  try {
    await gitIn(repo, ["add", "-A"], { noAuth: true, timeoutMs: 8000 });
    await gitIn(repo, ["commit", "-m", message], { noAuth: true, timeoutMs: 8000 });
  } catch {
    return false; // commit 失败（无变更等）
  }
  try {
    await gitIn(repo, ["push"], gitAuthOpts(15000));
    return true;
  } catch {
    return false; // 已本地提交，push 待补
  }
}

/** 提交消息：内容仓库统一 "[install] add <kind> <name>" */
export function installCommitMsg(kind: "skill" | "extension", name: string): string {
  return `[install] add ${kind} ${name}`;
}
