/**
 * skill-installer：/dpi-skills 一键安装（GitHub 链接 → 内容仓库 skills/）。
 *
 * 流程：解析来源 → 默认分支 → 探测 skills/ 下含 SKILL.md 的目录 →
 * 多选/单选 → 递归下载（SKILL.md + 引用文件）→ 冲突处理 → 落库 → commit+push。
 * 安装与声明解耦：不自动写 agent.json。
 *
 * 本文件不放 extensions/（pi 会把每个 .ts 当扩展入口，无 default 导出会报错）。
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  downloadTree,
  githubDefaultBranch,
  githubFindSkills,
  parseInstallSource,
} from "./github-source.ts";
import { commitAndPush, installCommitMsg } from "./install-common.ts";
import { showVimListPicker, type VimListItem } from "./vim-list-picker.ts";

export interface InstallOpts {
  apiBase?: string;
  rawBase?: string;
  proxy?: string;
}

/** 输入里拆出 --skill <name> 指定（对齐 npx skills add <repo> --skill <name> 语义） */
export function splitSkillFlag(input: string): { repoInput: string; skillName: string } {
  const m = /^(.*?)\s+--skill\s*[=:]?\s*([\w.-]+)\s*$/i.exec(input.trim());
  if (!m) return { repoInput: input.trim(), skillName: "" };
  return { repoInput: m[1].trim(), skillName: m[2].trim() };
}

/** 多 skill 时用选择器选一个（显示相对路径区分同名）；单个直接返回；取消返回 null */
async function pickSkill(
  ctx: ExtensionCommandContext,
  candidates: { path: string; name: string }[],
): Promise<{ path: string; name: string } | null> {
  if (candidates.length === 1) return candidates[0];
  const items: VimListItem<{ path: string; name: string }>[] = candidates.map((c) => ({
    id: c.path,
    label: c.name,
    meta: c.path.replace(/^skills\//, ""),
    data: c,
  }));
  const res = await showVimListPicker(ctx, { title: "Select skill", items, mode: "select" });
  if (!res || res.action !== "pick" || !res.item) return null;
  return res.item.data;
}

async function installSkillCore(
  ctx: ExtensionCommandContext,
  repo: string,
  input: string,
  opts: InstallOpts = {},
): Promise<boolean> {
  const { repoInput, skillName: wantSkill } = splitSkillFlag(input);
  const src = parseInstallSource(repoInput);
  if (!src || src.kind !== "github") {
    ctx.ui.notify("Expected a GitHub URL (e.g. https://github.com/owner/repo [--skill name])", "error");
    return false;
  }
  const { owner, repo: rname } = src;
  const branch = await githubDefaultBranch(owner, rname, opts.proxy, opts.apiBase);
  // 递归探测所有含 SKILL.md 的目录（支持分类组织仓库，如 skills/<cat>/<name>/）
  let skills = await githubFindSkills(owner, rname, branch, "skills", opts.proxy, { apiBase: opts.apiBase });
  // --skill 指定：精确匹配目录名；无匹配时报错
  if (wantSkill) {
    const hit = skills.find((c) => c.name === wantSkill);
    if (!hit) {
      ctx.ui.notify(`No skill named "${wantSkill}" found in ${owner}/${rname} (found: ${skills.map((s) => s.name).join(", ") || "none"})`, "error");
      return false;
    }
    skills = [hit];
  }
  if (skills.length === 0) {
    ctx.ui.notify(`No skills/ directory found in ${owner}/${rname}`, "warning");
    return false;
  }
  const chosen = await pickSkill(ctx, skills);
  if (!chosen) return false;
  const skillName = chosen.name;
  const tree = await downloadTree(owner, rname, branch, chosen.path, opts.proxy, opts);
  if (!tree.has("SKILL.md")) {
    ctx.ui.notify(`${skillName} is not a valid skill (missing SKILL.md)`, "error");
    return false;
  }
  // 名称冲突：覆盖 / 跳过 / 换名
  let finalName = skillName;
  if (existsSync(join(repo, "skills", skillName))) {
    const choice = await ctx.ui.select(`skills/${skillName} already exists`, [
      "Overwrite",
      "Skip",
      "Save as new name",
    ]);
    if (choice === "Skip" || choice === undefined) {
      if (choice === "Skip") ctx.ui.notify(`Skipped ${skillName}`, "info");
      return true;
    }
    if (choice === "Save as new name") {
      let i = 2;
      while (existsSync(join(repo, "skills", `${skillName}-${i}`))) i++;
      finalName = `${skillName}-${i}`;
    }
  }
  const destDir = join(repo, "skills", finalName);
  for (const [rel, content] of tree) {
    const full = join(destDir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf-8");
  }
  const pushed = await commitAndPush(repo, installCommitMsg("skill", finalName));
  ctx.ui.notify(
    `Installed ${finalName}${pushed ? "" : " (committed locally, push pending)"} — enable it via /dpi-skills`,
    "info",
  );
  return true;
}

/** 对外入口 */
export async function installSkill(
  ctx: ExtensionCommandContext,
  repo: string,
  input: string,
): Promise<boolean> {
  return installSkillCore(ctx, repo, input);
}

/** 测试入口：可注入 api/raw base 与代理 */
export async function installSkillWithBase(
  ctx: ExtensionCommandContext,
  repo: string,
  input: string,
  opts: InstallOpts = {},
): Promise<boolean> {
  return installSkillCore(ctx, repo, input, opts);
}
