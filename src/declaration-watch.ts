/**
 * declaration-watch：agent 声明文件（agent.json）变更检测器。
 *
 * resources_discover 只在会话启动/重载时执行——会话中 agent.json 被
 * 外部改动（本地编辑、远端拉取）不会生效。本检测器在每轮
 * before_agent_start 时轻量 stat 对比 mtime+size，检测到变化后由
 * 调用方在安全时机（agent_settled 空闲）触发 reload。
 *
 * 注意：SYSTEM.md 由 before_agent_start 每轮实时读取，自动生效，
 * 无需检测；这里只盯 agent.json（技能/扩展声明的裁决文件）。
 *
 * 本文件不放 extensions/（pi 会把每个 .ts 当扩展入口，无 default 导出会报错）。
 */
import { statSync } from "node:fs";
import { join } from "node:path";

export class DeclarationWatch {
  private last = new Map<string, string>(); // 文件绝对路径 -> mtimeMs:size

  /**
   * 检测 agent.json 是否自上次调用以来发生变化。
   * 首次调用只记录基线，返回 false（避免启动即误触发）。
   */
  changed(repoPath: string, agent: string): boolean {
    const file = join(repoPath, "agents", agent, "agent.json");
    let key: string | null = null;
    try {
      const st = statSync(file);
      key = `${st.mtimeMs}:${st.size}`;
    } catch {
      key = null; // 文件不存在（agent 目录缺失）
    }
    const prev = this.last.get(file);
    this.last.set(file, key ?? "");
    return prev !== undefined && prev !== (key ?? "");
  }
}
