/**
 * skill-manager：/skills 交互管理当前 agent 的技能组合。
 *
 * 主循环与删除流程由 src/registry-manager.ts 泛型实现（与 /extensions 同构），
 * 本文件只提供技能注册表的差异部分：扫描（skills/ 目录 + SKILL.md frontmatter
 * description）与写回（writeAgentManifestSkills）。
 *
 * 内容仓库路径全部来自 dpi 配置（config.repoPath）；未绑定时提示先 /agent-login。
 * agent 名与技能名一律 /^[\w-]+$/ 白名单校验防路径穿越；文件读写逐步容错，绝不抛出。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  readAgentManifest,
  writeAgentManifestSkills,
} from "../src/config.ts";
import { runRegistryManager, type RegistryManagerConfig } from "../src/registry-manager.ts";
import { registerDpiCommand } from "../src/command-alias.ts";

/** 读 skills/<name>/SKILL.md frontmatter 的 description（单行），截断 ~40 字符 */
function skillDescription(path: string): string {
  try {
    const head = readFileSync(path, "utf-8").slice(0, 4000);
    const fm = /^---\n([\s\S]*?)\n---/.exec(head);
    if (!fm) return "";
    const line = fm[1].split("\n").find((l) => /^description\s*:/.test(l));
    if (!line) return "";
    const desc = line
      .replace(/^description\s*:\s*/, "")
      .trim()
      .replace(/^["']|["']$/g, "");
    // YAML 折叠/块标量（>、| 开头）无法单行展示，按无描述处理
    if (!desc || /^[>|]/.test(desc)) return "";
    return desc.length > 40 ? `${desc.slice(0, 39)}…` : desc;
  } catch {
    return "";
  }
}

/** 扫描仓库根 skills/ 注册表：含 SKILL.md 的子目录（目录名白名单校验），按名排序 */
function scanRegistrySkills(repo: string): { name: string; description: string }[] {
  try {
    const dir = join(repo, "skills");
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter(
        (e) =>
          e.isDirectory() &&
          /^[\w-]+$/.test(e.name) &&
          existsSync(join(dir, e.name, "SKILL.md")),
      )
      .map((e) => ({ name: e.name, description: skillDescription(join(dir, e.name, "SKILL.md")) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

const config: RegistryManagerConfig = {
  kindLabel: "技能",
  declaredField: "skills",
  scanRegistry: scanRegistrySkills,
  readDeclared: (repo, agent) => readAgentManifest(repo, agent).skills,
  writeDeclared: writeAgentManifestSkills,
  deletePath: (repo, name) =>
    rmSync(join(repo, "skills", name), { recursive: true, force: true }),
};

export default function (pi: ExtensionAPI) {
  // /skills：交互勾选/取消当前 agent 的技能，或删除注册表技能
  registerDpiCommand(pi, "dpi-skills", {
    description: "交互管理当前 agent 的技能组合（勾选/删除注册表技能）",
    handler: async (_args, ctx) => {
      await runRegistryManager(ctx, config);
    },
  });
}
