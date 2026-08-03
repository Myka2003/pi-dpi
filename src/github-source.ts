/**
 * github-source：一键安装的来源解析与 GitHub API 封装（skill/扩展安装共用）。
 *
 * 来源形态：
 * - GitHub URL（https://github.com/owner/repo，可带 tree/blob 路径）
 * - owner/repo 简写
 * - npm 包名（npm:name 或裸名）
 *
 * API 封装全部走 curl 子进程（复用代理配置），可注入 apiBase/rawBase 供测试
 * 指向本地模拟 server。公共仓库免认证（GitHub API 强制 User-Agent）。
 *
 * 本文件不放 extensions/（pi 会把每个 .ts 当扩展入口，无 default 导出会报错）。
 */
import { execFileSync } from "node:child_process";
import { loadConfig } from "./config.ts";

export type InstallSource =
  | { kind: "github"; owner: string; repo: string }
  | { kind: "npm"; name: string };

const GITHUB_URL = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)/i;

/** 从 GitHub URL（任意形态：根/tree/blob/raw）提取 owner/repo；非 GitHub 返回 null */
export function githubOwnerRepo(input: string): { owner: string; repo: string } | null {
  const s = input.trim();
  const m = GITHUB_URL.exec(s);
  if (m) return { owner: m[1], repo: m[2] };
  // owner/repo 简写（不含协议/路径）
  const brief = /^([\w.-]+)\/([\w.-]+)$/.exec(s);
  if (brief && !s.includes("://")) return { owner: brief[1], repo: brief[2] };
  return null;
}

/** 解析安装来源：GitHub URL / owner/repo → github；npm 名（npm: 前缀或裸名）→ npm */
export function parseInstallSource(input: string): InstallSource | null {
  const s = input.trim();
  if (!s) return null;
  const gh = githubOwnerRepo(s);
  if (gh) return { kind: "github", ...gh };
  const npmName = s.startsWith("npm:") ? s.slice(4).trim() : s;
  if (/^[\w@./-]+$/.test(npmName) && !npmName.includes("://")) {
    return { kind: "npm", name: npmName };
  }
  return null;
}

/** curl 拉取（-fsSL 静默失败即抛错；proxy 为 "" 时不加 -x） */
export function fetchUrl(
  url: string,
  opts: { proxy?: string; timeoutMs?: number } = {},
): string {
  const secs = Math.max(5, Math.round((opts.timeoutMs ?? 30000) / 1000));
  const args = ["-fsSL", "--max-time", String(secs)];
  if (opts.proxy) args.push("-x", opts.proxy);
  args.push(url);
  return execFileSync("curl", args, { encoding: "utf-8" });
}

function proxyOf(): string {
  try {
    return loadConfig().proxy ?? "";
  } catch {
    return "";
  }
}

/** GitHub 默认分支（仓库信息 API）；失败回退 "main" */
export async function githubDefaultBranch(
  owner: string,
  repo: string,
  proxy = proxyOf(),
  apiBase = "https://api.github.com",
): Promise<string> {
  try {
    const out = fetchUrl(`${apiBase}/repos/${owner}/${repo}`, { proxy });
    const j = JSON.parse(out) as { default_branch?: unknown };
    return typeof j.default_branch === "string" && j.default_branch ? j.default_branch : "main";
  } catch {
    return "main";
  }
}

/** 列 GitHub 目录（contents API）；失败返回 [] */
export async function githubListDir(
  owner: string,
  repo: string,
  branch: string,
  path: string,
  proxy = proxyOf(),
  apiBase = "https://api.github.com",
): Promise<{ name: string; type: "file" | "dir" }[]> {
  try {
    const out = fetchUrl(
      `${apiBase}/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`,
      { proxy },
    );
    const arr = JSON.parse(out) as { name?: unknown; type?: unknown }[];
    return arr
      .filter((e) => typeof e.name === "string" && (e.type === "file" || e.type === "dir"))
      .map((e) => ({ name: e.name as string, type: e.type as "file" | "dir" }));
  } catch {
    return [];
  }
}

/** 拉单个文件（raw）；失败返回 "" */
export async function githubFetchFile(
  owner: string,
  repo: string,
  branch: string,
  path: string,
  proxy = proxyOf(),
  rawBase = "https://raw.githubusercontent.com",
): Promise<string> {
  try {
    return fetchUrl(
      `${rawBase}/${owner}/${repo}/${encodeURIComponent(branch)}/${path}`,
      { proxy },
    );
  } catch {
    return "";
  }
}

/** 递归下载目录下全部文件：相对路径 → 内容（失败的文件跳过） */
export async function downloadTree(
  owner: string,
  repo: string,
  branch: string,
  dirPath: string,
  proxy = proxyOf(),
  opts: { apiBase?: string; rawBase?: string } = {},
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const items = await githubListDir(owner, repo, branch, dirPath, proxy, opts.apiBase);
  for (const it of items) {
    const rel = `${dirPath}/${it.name}`;
    if (it.type === "dir") {
      const sub = await downloadTree(owner, repo, branch, rel, proxy, opts);
      for (const [k, v] of sub) out.set(k, v);
    } else {
      const content = await githubFetchFile(owner, repo, branch, rel, proxy, opts.rawBase);
      if (content !== "") out.set(rel.slice(dirPath.length + 1), content);
    }
  }
  return out;
}
