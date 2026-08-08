/**
 * repo-doctor：内容仓库状态检查与修复。
 *
 * inspectRepo 对绑定仓库做只读体检（远端、分支、HEAD、dirty、可选网络 dry-run）；
 * repairRepo 在远端/分支/稀疏模式跑偏时以最小操作修复（set-url + checkout + sparse
 * 重设），仅当仓库目录完全缺失时才重新 clone。全部 git 操作走 git.ts 共享封装。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, gitAuthOpts } from "./config.ts";
import { git, gitIn } from "./git.ts";

const SPARSE_DIRS = ["agents", "extensions", "skills", "docs", "profiles", "machines", "README.md", "package.json"];

export interface RepoDoctorReport {
  ok: boolean;
  issues: string[];
  remoteUrl: string;
  branch: string;
  head: string;
  dirty: boolean;
}

async function gitText(repo: string, args: string[]): Promise<string> {
  const { stdout } = await gitIn(repo, args, { noAuth: true, timeoutMs: 8000 });
  return stdout.trim();
}

export async function inspectRepo(options: { network?: boolean } = {}): Promise<RepoDoctorReport> {
  const cfg = loadConfig();
  const issues: string[] = [];
  let remoteUrl = "";
  let branch = "";
  let head = "";
  let dirty = false;

  if (!cfg.repoUrl) issues.push("repoUrl missing in dpi config");
  if (!existsSync(cfg.repoPath)) issues.push(`repoPath missing: ${cfg.repoPath}`);
  else if (!existsSync(join(cfg.repoPath, ".git"))) issues.push(`repoPath is not a git repo: ${cfg.repoPath}`);
  else {
    remoteUrl = await gitText(cfg.repoPath, ["remote", "get-url", "origin"]).catch(() => "");
    branch = await gitText(cfg.repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "");
    head = await gitText(cfg.repoPath, ["rev-parse", "--short", "HEAD"]).catch(() => "");
    dirty = (await gitText(cfg.repoPath, ["status", "--porcelain"]).catch(() => "")) !== "";
    if (!remoteUrl) issues.push("origin remote missing");
    else if (cfg.repoUrl && remoteUrl !== cfg.repoUrl) issues.push(`remote mismatch: ${remoteUrl}`);
    if (branch !== cfg.branch) issues.push(`branch mismatch: ${branch}`);
    if (options.network === true) {
      await gitIn(cfg.repoPath, ["fetch", "--dry-run", "origin"], gitAuthOpts(15000))
        .catch((error) => issues.push(`fetch dry-run failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  return { ok: issues.length === 0, issues, remoteUrl, branch, head, dirty };
}

export async function repairRepo(): Promise<RepoDoctorReport> {
  const cfg = loadConfig();
  if (!existsSync(join(cfg.repoPath, ".git"))) {
    await git(["clone", "--filter=blob:none", "--sparse", cfg.repoUrl, cfg.repoPath], gitAuthOpts(120000));
    await gitIn(cfg.repoPath, ["sparse-checkout", "set", ...SPARSE_DIRS], gitAuthOpts(30000));
  } else {
    await gitIn(cfg.repoPath, ["remote", "set-url", "origin", cfg.repoUrl], gitAuthOpts());
    // 空仓库（unborn HEAD）无法 checkout，直接跳过；有 HEAD 时才在分支不符时切分支
    const hasHead = (await gitText(cfg.repoPath, ["rev-parse", "--verify", "--quiet", "HEAD"]).catch(() => "")) !== "";
    if (hasHead) {
      const currentBranch = await gitText(cfg.repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "");
      if (currentBranch !== cfg.branch) {
        await gitIn(cfg.repoPath, ["checkout", cfg.branch], gitAuthOpts(30000));
      }
    }
    await gitIn(cfg.repoPath, ["sparse-checkout", "set", ...SPARSE_DIRS], gitAuthOpts(30000));
  }
  return inspectRepo({ network: false });
}
