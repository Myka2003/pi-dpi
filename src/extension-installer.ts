/**
 * extension-installer：/dpi-extensions 一键安装（GitHub 链接或 npm 包名）。
 *
 * GitHub 分支：探测 extensions/（*.ts 单文件或目录型 index.ts）→ 下载 → 落库。
 * npm 分支：执行 pi install npm:<name>（pi 原生装到 ~/.pi/agent/npm/），
 * 并把依赖记录进内容仓库 package.json（跨机器 ensureRepoDeps 自动 npm install）。
 * 安装与声明解耦：不自动写 agent.json。
 *
 * 本文件不放 extensions/（pi 会把每个 .ts 当扩展入口，无 default 导出会报错）。
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  downloadTree,
  githubDefaultBranch,
  githubFetchFile,
  githubListDir,
  parseInstallSource,
} from "./github-source.ts";
import { commitAndPush, installCommitMsg, safeName } from "./install-common.ts";
import type { InstallOpts } from "./skill-installer.ts";
import { showVimListPicker, type VimListItem } from "./vim-list-picker.ts";

/** 执行 pi install npm:<name>；失败捕获返回 {ok:false,error}（pi 不在 PATH / 包不存在等） */
export function piInstallNpm(name: string): { ok: boolean; error?: string } {
  try {
    execFileSync("pi", ["install", `npm:${name}`], { stdio: "ignore", timeout: 120000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 在内容仓库 package.json 的 dependencies 记录 npm 包（幂等；无 package.json 则创建） */
export function recordNpmDependency(repo: string, name: string): void {
  const pkgPath = join(repo, "package.json");
  let pkg: Record<string, unknown>;
  try {
    pkg = existsSync(pkgPath)
      ? (JSON.parse(readFileSync(pkgPath, "utf-8")) as Record<string, unknown>)
      : {};
  } catch {
    pkg = {};
  }
  const deps = (pkg.dependencies as Record<string, string> | undefined) ?? {};
  if (deps[name]) return;
  deps[name] = "*";
  pkg.dependencies = deps;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
}

async function pickOne(
  ctx: ExtensionCommandContext,
  names: string[],
  title: string,
): Promise<string | null> {
  if (names.length === 1) return names[0];
  const items: VimListItem<string>[] = names.map((n) => ({ id: n, label: n, data: n }));
  const res = await showVimListPicker(ctx, { title, items, mode: "select" });
  if (!res || res.action !== "pick" || !res.item) return null;
  return res.item.data;
}

async function installFromGithub(
  ctx: ExtensionCommandContext,
  repo: string,
  owner: string,
  rname: string,
  opts: InstallOpts,
): Promise<boolean> {
  const branch = await githubDefaultBranch(owner, rname, opts.proxy, opts.apiBase);
  const entries = await githubListDir(owner, rname, branch, "extensions", opts.proxy, opts.apiBase);
  const singleFiles = entries
    .filter((e) => e.type === "file" && e.name.endsWith(".ts") && safeName(e.name.replace(/\.ts$/, "")))
    .map((e) => e.name);
  const dirs = entries
    .filter((e) => e.type === "dir" && safeName(e.name))
    .map((e) => e.name);
  if (singleFiles.length === 0 && dirs.length === 0) {
    ctx.ui.notify(`No extensions/ directory found in ${owner}/${rname}`, "warning");
    return false;
  }
  const all = [...singleFiles, ...dirs];
  const chosen = await pickOne(ctx, all, "Select extension");
  if (!chosen) return false;
  const base = chosen.replace(/\.ts$/, "");
  // 冲突处理：覆盖 / 跳过 / 换名
  let finalBase = base;
  if (existsSync(join(repo, "extensions", chosen)) || existsSync(join(repo, "extensions", base))) {
    const choice = await ctx.ui.select(`extensions/${base} already exists`, [
      "Overwrite",
      "Skip",
      "Save as new name",
    ]);
    if (choice === "Skip" || choice === undefined) {
      if (choice === "Skip") ctx.ui.notify(`Skipped ${base}`, "info");
      return true;
    }
    if (choice === "Save as new name") {
      let i = 2;
      while (
        existsSync(join(repo, "extensions", `${base}-${i}`)) ||
        existsSync(join(repo, "extensions", `${base}-${i}.ts`))
      ) {
        i++;
      }
      finalBase = `${base}-${i}`;
    }
  }
  if (singleFiles.includes(chosen)) {
    const content = await githubFetchFile(owner, rname, branch, `extensions/${chosen}`, opts.proxy, opts.rawBase);
    if (!content) {
      ctx.ui.notify(`Failed to fetch extensions/${chosen}`, "error");
      return false;
    }
    writeFileSync(join(repo, "extensions", `${finalBase}.ts`), content, "utf-8");
  } else {
    const tree = await downloadTree(owner, rname, branch, `extensions/${chosen}`, opts.proxy, opts);
    const destDir = join(repo, "extensions", finalBase);
    for (const [rel, content] of tree) {
      const full = join(destDir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, "utf-8");
    }
  }
  const pushed = await commitAndPush(repo, installCommitMsg("extension", finalBase));
  ctx.ui.notify(
    `Installed extension ${finalBase}${pushed ? "" : " (committed locally, push pending)"} — enable it via /dpi-extensions`,
    "info",
  );
  return true;
}

async function installExtensionCore(
  ctx: ExtensionCommandContext,
  repo: string,
  input: string,
  opts: InstallOpts = {},
): Promise<boolean> {
  const src = parseInstallSource(input);
  if (!src) {
    ctx.ui.notify("Invalid input: GitHub URL or npm package name", "error");
    return false;
  }
  if (src.kind === "github") {
    return installFromGithub(ctx, repo, src.owner, src.repo, opts);
  }
  const r = piInstallNpm(src.name);
  if (!r.ok) {
    ctx.ui.notify(`pi install failed: ${r.error ?? "unknown error"}`, "error");
    return false;
  }
  recordNpmDependency(repo, src.name);
  const pushed = await commitAndPush(repo, installCommitMsg("extension", src.name));
  ctx.ui.notify(
    `Installed npm extension ${src.name}${pushed ? "" : " (recorded locally, push pending)"}`,
    "info",
  );
  return true;
}

/** 对外入口 */
export async function installExtension(
  ctx: ExtensionCommandContext,
  repo: string,
  input: string,
): Promise<boolean> {
  return installExtensionCore(ctx, repo, input);
}

/** 测试入口：可注入 api/raw base 与代理 */
export async function installExtensionWithBase(
  ctx: ExtensionCommandContext,
  repo: string,
  input: string,
  opts: InstallOpts = {},
): Promise<boolean> {
  return installExtensionCore(ctx, repo, input, opts);
}
