/**
 * registry-manager：注册表管理器泛型实现（/skills 与 /extensions 的共享逻辑）。
 *
 * 两个命令是同构的：主循环用 VimListPicker（toggle 模式）——空格/Enter 切换
 * 勾选（●/○），d 删除当前条目（confirm 后 rm + 从所有 agent 声明剔除），
 * Esc/q 完成并写回声明。差异只在注册表形态（技能=目录+SKILL.md+description，
 * 扩展=顶层 .ts 文件）与写回函数，故抽成参数注入的单一实现。
 *
 * 本文件不放 extensions/（pi 会把每个 .ts 当扩展加载，无 default 导出会报错），
 * 由 skill-manager.ts / ext-manager.ts 薄壳调用。
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, readAgentManifest, syncExtensionFilter } from "./config.ts";
import { errMsg, safeAgentName, scanManifestAgents } from "./common.ts";
import { showVimListPicker, type VimListItem } from "./vim-list-picker.ts";

export interface RegistryEntry {
  name: string;
  description: string;
}

export interface RegistryManagerConfig {
  /** 中文标签（选项标题/通知文案用）：技能 / 扩展 */
  kindLabel: string;
  /** agent.json 里的声明字段名 */
  declaredField: "skills" | "extensions";
  /** 扫描注册表（白名单校验 + 排序由实现负责） */
  scanRegistry(repo: string): RegistryEntry[];
  /** 读当前 agent 已声明列表 */
  readDeclared(repo: string, agent: string): string[];
  /** 写回当前 agent 声明列表；返回是否成功 */
  writeDeclared(repo: string, agent: string, names: string[]): boolean;
  /** 删除注册表条目（rm 目录或文件） */
  deletePath(repo: string, name: string): void;
  /** 配套资源检查（防屎山）：扩展 ↔ 同名技能的联动删除/提示 */
  companion?: {
    /** 另一侧的注册表目录名（扩展→"skills"，技能→"extensions"） */
    registryDir: string;
    /** 另一侧的 kindLabel（提示文案用） */
    companionLabel: string;
    /** 另一侧条目的形态：扩展=目录或文件，技能=目录 */
    entryExists(repo: string, name: string): boolean;
  };
}

/** 从所有 agent 的指定声明字段中剔除一个名字；返回受影响 agent 数 */
function stripFromAllAgents(
  repo: string,
  rc: RegistryManagerConfig,
  field: "skills" | "extensions",
  name: string,
): number {
  let affected = 0;
  for (const agent of scanManifestAgents(repo)) {
    const manifest = readAgentManifest(repo, agent);
    const list = manifest[field];
    if (!list.includes(name)) continue;
    if (rc.writeDeclared(repo, agent, list.filter((s) => s !== name))) affected++;
  }
  return affected;
}

/**
 * 删除流程：confirm 确认 → deletePath + 从所有 agent 声明中剔除；
 * 有同名配套资源（扩展↔技能）时联动处理，防止「删了扩展技能还在」的孤儿屎山。
 */
async function deleteFlow(
  ctx: ExtensionCommandContext,
  repo: string,
  rc: RegistryManagerConfig,
  name: string,
): Promise<boolean> {
  if (!/^[\w-]+$/.test(name)) return false;
  // 防屎山：删除前检查同名配套资源，一起确认
  const companion = rc.companion;
  const hasCompanion =
    companion && companion.entryExists(repo, name) &&
    existsSync(join(repo, companion.registryDir, name));
  const companionNote = hasCompanion
    ? `\n\n⚠ 发现同名${companion!.companionLabel}（${companion!.registryDir}/${name}/），将一并删除（同名约定：${rc.kindLabel}与配套${companion!.companionLabel}同名联动）`
    : "";
  const ok = await ctx.ui.confirm(
    `删除${rc.kindLabel}`,
    `删除该${rc.kindLabel}（${name}）并从所有 agent 声明中移除（git 可恢复）。${companionNote}确认？`,
  );
  if (!ok) return false;
  try {
    rc.deletePath(repo, name);
  } catch (e) {
    ctx.ui.notify(`删除失败：${errMsg(e)}`, "error");
    return false;
  }
  let affected = stripFromAllAgents(repo, rc, rc.declaredField, name);
  let companionAffected = 0;
  // 联动删除同名配套资源（扩展↔技能），并从对应声明字段剔除
  if (hasCompanion && companion) {
    try {
      rmSync(join(repo, companion.registryDir, name), { recursive: true, force: true });
      const companionField = rc.declaredField === "skills" ? "extensions" : "skills";
      const companionRc = {
        ...rc,
        declaredField: companionField as "skills" | "extensions",
      };
      companionAffected = stripFromAllAgents(repo, companionRc, companionField, name);
    } catch {
      // 配套删除失败不阻断主删除（残留由下次操作处理）
    }
  }
  ctx.ui.notify(
    `已删除 ${name}（影响 ${affected} 个 agent${hasCompanion ? `，配套${companion?.companionLabel}联动删除影响 ${companionAffected} 个` : ""}）`,
    "info",
  );
  return true;
}

/**
 * /skills 与 /extensions 命令的共享实现：
 * 非 UI 只报已声明列表；UI 用 VimListPicker toggle 模式（勾选/删除），
 * 完成时（有改动）reload；扩展命令额外先同步扩展过滤器。
 */
export async function runRegistryManager(
  ctx: ExtensionCommandContext,
  rc: RegistryManagerConfig,
): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.repoUrl) {
    ctx.ui.notify("未绑定内容仓库，请先 /agent-login", "warning");
    return;
  }
  const repo = cfg.repoPath;
  const agent = safeAgentName(cfg.currentAgent);

  if (!ctx.hasUI) {
    const declared = rc.readDeclared(repo, agent);
    ctx.ui.notify(
      `当前 agent: ${agent}\n已声明${rc.kindLabel}: ${declared.join(", ") || "（无）"}`,
      "info",
    );
    return;
  }

  // 主循环：VimListPicker toggle 模式——空格/Enter 切换勾选，d 删除，
  // Esc/q 完成；完成时把勾选集写回 agent.json（与现状一致则不写）
  let dirty = false;
  for (;;) {
    const registry = rc.scanRegistry(repo);
    const declared = rc.readDeclared(repo, agent);
    const items: VimListItem<RegistryEntry>[] = registry.map((e) => ({
      id: e.name,
      label: e.description ? `${e.name} — ${e.description}` : e.name,
      checked: declared.includes(e.name),
      data: e,
    }));
    const res = await showVimListPicker(ctx, {
      title: `${rc.kindLabel} — ${agent}（● 已声明）`,
      items,
      mode: "toggle",
      actions: [{ key: "d", id: "delete", hint: "d 删除" }],
    });
    if (!res) break; // TUI 不可用/异常
    if (res.action === "delete" && res.item) {
      if (await deleteFlow(ctx, repo, rc, res.item.data.name)) dirty = true;
      continue; // 重开选择器（注册表已变化）
    }
    // cancel / 完成：写回勾选集（无变化则不写）
    const next = res.checked ?? declared;
    const same =
      next.length === declared.length && [...next].sort().join("\n") === [...declared].sort().join("\n");
    if (!same) {
      if (rc.writeDeclared(repo, agent, next)) {
        dirty = true;
      } else {
        ctx.ui.notify(`写入 agents/${agent}/agent.json 失败`, "error");
      }
    }
    break;
  }

  if (!dirty) return; // 未改动：不打扰，直接返回
  // 扩展命令先同步内容包 extensions 过滤器（技能无此步骤）；再 reload
  // 让 resources_discover 按新组合重新发现。失败不吞掉已写入的声明。
  if (rc.declaredField === "extensions") syncExtensionFilter(loadConfig());
  try {
    await ctx.reload();
  } catch {
    // reload 失败不影响已保存的组合
  }
  const count = rc.readDeclared(repo, agent).length;
  ctx.ui.notify(`已保存：${agent} 现在启用 ${count} 个${rc.kindLabel}`, "info");
}
