/**
 * bootstrap：内容仓库最小结构初始化（/dpi-agent-login 绑定本地路径时用）。
 * 目录不存在或缺少 agents/ 时自动创建 agents/coder/SYSTEM.md + agent.json
 * 与注册表骨架；已存在结构则不动作（幂等）。
 * 本文件不放 extensions/（pi 会把每个 .ts 当扩展入口）。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_SYSTEM_MD = `# Coder Agent

You are a pragmatic full-stack engineer. Direct, no fluff.

## Principles
- Read code before concluding; never guess at non-existent implementations
- Minimal changes; don't refactor unrelated code
- Answer in English; keep code and identifiers in English
`;

const DEFAULT_AGENT_JSON = {
  description: "Full-stack engineer: writes code, runs commands",
  skills: [],
  extensions: [],
};

const SKEL_DIRS = ["skills", "extensions", "machines", "memory", "sessions"];

export function ensureContentRepo(repoPath: string): { created: boolean } {
  try {
    if (existsSync(join(repoPath, "agents", "coder", "SYSTEM.md"))) {
      return { created: false };
    }
    mkdirSync(join(repoPath, "agents", "coder"), { recursive: true });
    for (const d of SKEL_DIRS) mkdirSync(join(repoPath, d), { recursive: true });
    try {
      execFileSync("git", ["init"], { cwd: repoPath, stdio: "ignore" });
    } catch {
      // git 不可用则跳过（本地单机仍可用，远端同步不可用）
    }
    writeFileSync(join(repoPath, "agents", "coder", "SYSTEM.md"), DEFAULT_SYSTEM_MD);
    writeFileSync(
      join(repoPath, "agents", "coder", "agent.json"),
      `${JSON.stringify(DEFAULT_AGENT_JSON, null, 2)}\n`,
    );
    return { created: true };
  } catch {
    return { created: false };
  }
}
