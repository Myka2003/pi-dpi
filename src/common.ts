/**
 * dpi 共享辅助：被 extensions/ 下各扩展以相对路径 import。
 *
 * 约定与 src/config.ts 一致：
 * - 纯函数 + 类型，import 时零副作用；
 * - 本文件不放在 extensions/ 下——pi 会把 extensions/ 里每个 .ts 当扩展加载，
 *   没有 default 导出函数的文件会产生加载错误；
 * - 所有读取一律容错回退默认，绝不抛异常阻断 pi 启动。
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** 异常 → 可读错误消息 */
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** agent 名白名单校验（同时是防路径穿越），非法回退 coder */
export function safeAgentName(name: string): string {
  return /^[\w-]+$/.test(name) ? name : "coder";
}

/** agents/ 下所有含 agent.json 的子目录名（白名单校验），供批量剔除声明等场景 */
export function scanManifestAgents(repo: string): string[] {
  try {
    const dir = join(repo, "agents");
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter(
        (e) =>
          e.isDirectory() &&
          /^[\w-]+$/.test(e.name) &&
          existsSync(join(dir, e.name, "agent.json")),
      )
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}
