/**
 * ext-manager：/extensions 交互管理当前 agent 的扩展组合。
 *
 * 主循环与删除流程由 src/registry-manager.ts 泛型实现（与 /skills 同构），
 * 本文件只提供扩展注册表的差异部分：扫描（extensions/ 顶层 .ts 文件）与写回
 * （writeAgentManifestExtensions）。完成时由 registry-manager 先同步扩展
 * 过滤器再 reload（过滤发生在 import 之前，未声明的扩展不执行）。
 *
 * 内容仓库路径全部来自 dpi 配置（config.repoPath）；未绑定时提示先 /agent-login。
 * agent 名与扩展名一律 /^[\w-]+$/ 白名单校验防路径穿越；文件读写逐步容错，绝不抛出。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readAgentManifest, writeAgentManifestExtensions, loadConfig } from "../src/config.ts";
import { runRegistryManager, type RegistryManagerConfig } from "../src/registry-manager.ts";
import { installExtension } from "../src/extension-installer.ts";
import { registerDpiCommand } from "../src/command-alias.ts";

/** 扫描仓库根 extensions/ 注册表：顶层 .ts 文件 + 目录型（index.ts 或 package.json 入口），按名排序 */
function scanRegistryExtensions(repo: string): { name: string; description: string }[] {
  try {
    const dir = join(repo, "extensions");
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => {
        if (e.isFile() && /^[\w-]+\.ts$/.test(e.name)) return true;
        if (e.isDirectory() && /^[\w-]+$/.test(e.name)) {
          return (
            existsSync(join(dir, e.name, "index.ts")) ||
            existsSync(join(dir, e.name, "package.json"))
          );
        }
        return false;
      })
      .map((e) => ({ name: e.name.replace(/\.ts$/, ""), description: "" }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

const config: RegistryManagerConfig = {
  kindLabel: "扩展",
  declaredField: "extensions",
  scanRegistry: scanRegistryExtensions,
  readDeclared: (repo, agent) => readAgentManifest(repo, agent).extensions,
  writeDeclared: writeAgentManifestExtensions,
  deletePath: (repo, name) => {
    const file = join(repo, "extensions", `${name}.ts`);
    if (existsSync(file)) {
      rmSync(file, { force: true }); // 单文件扩展
    } else {
      rmSync(join(repo, "extensions", name), { recursive: true, force: true }); // 目录型扩展
    }
  },
  companion: {
    registryDir: "skills",
    companionLabel: "技能",
    entryExists: (repo, name) => existsSync(join(repo, "skills", name, "SKILL.md")),
  },
  addEntry: {
    label: "Add extension (GitHub / npm)",
    handler: async (ctx, repo, input) => installExtension(ctx, repo, input),
  },
};

export default function (pi: ExtensionAPI) {
  // /extensions：交互勾选/取消当前 agent 的扩展，或删除注册表扩展
  registerDpiCommand(pi, "dpi-extensions", {
    description: "Manage current agent extensions (toggle/delete registry extensions)",
    handler: async (args, ctx) => {
      const a = (args ?? "").trim();
      // CLI 化：/dpi-extensions add <github-url|npm-pkg> 直接安装
      if (a.startsWith("add ")) {
        const cfg = loadConfig();
        if (!cfg.repoUrl) {
          ctx.ui.notify("No content repo bound, run /dpi-agent-login first", "warning");
          return;
        }
        await installExtension(ctx, cfg.repoPath, a.slice(4).trim());
        return;
      }
      await runRegistryManager(ctx, config);
    },
  });
}
