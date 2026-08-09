/**
 * dpi-console：统一 /dpi 控制台（gateway / repo / skill / ext 四类条目的
 * 列表构建 + 按键路由 + 添加流程）。
 *
 * 条目来源：
 * - gateway：scanGatewayProfiles（src/gateway-profile.ts）
 * - repo：config.repoUrl 绑定的内容仓库
 * - skill / ext：extensions/skill-manager.ts / extensions/ext-manager.ts 的
 *   注册表扫描函数（薄壳导出）；增删走 runRegistryManager（与 /dpi-skills、
 *   /dpi-extensions 同构的主循环）
 *
 * add-gateway 流程严格按顺序：输入 id/label/baseUrl/key → writeCredential →
 * fetchGatewayModels → buildGatewayProfile → writeGatewayProfile →
 * commitPushGateway → notify；commit 前任何一步失败都回滚删除 credential
 * （API key 只进 credential-store，绝不写入日志或 notify 文案）。
 *
 * 本文件不放 extensions/（pi 会把每个 .ts 当扩展入口，无 default 导出会报错），
 * 由 extensions/dpi-console.ts 薄壳调用。
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, readAgentManifest } from "./config.ts";
import { safeAgentName } from "./common.ts";
import { deleteCredential, validateRef, writeCredential } from "./credential-store.ts";
import { fetchGatewayModels } from "./gateway-catalog.ts";
import { checkGatewayHealth } from "./gateway-health.ts";
import { scanGatewayProfiles, type GatewayModel } from "./gateway-profile.ts";
import {
  buildGatewayProfile,
  commitPushGateway,
  deleteGatewayProfile,
  writeGatewayProfile,
} from "./gateway-writer.ts";
import { runRegistryManager } from "./registry-manager.ts";
import { bindRepoWithKey } from "./repo-binder.ts";
import type { VimListItem, VimListResult } from "./vim-list-picker.ts";
import { config as extManagerConfig, scanRegistryExtensions } from "../extensions/ext-manager.ts";
import { config as skillManagerConfig, scanRegistrySkills } from "../extensions/skill-manager.ts";

export type ConsoleItemKind = "gateway" | "repo" | "skill" | "ext";

export interface ConsoleItemData {
  kind: ConsoleItemKind;
  id: string;
  meta: string;
}

export interface ConsoleItemsConfig {
  repoPath: string;
  repoUrl: string;
  currentGateway: string;
  /** 当前 agent（可选）：用于标记已声明的 skill/ext */
  currentAgent?: string;
}

export function buildConsoleItems(cfg: ConsoleItemsConfig): VimListItem<ConsoleItemData>[] {
  const items: VimListItem<ConsoleItemData>[] = [];
  if (cfg.repoUrl) {
    items.push({
      id: "repo:current",
      label: `[repo] ${cfg.repoUrl}`,
      meta: "bound",
      data: { kind: "repo", id: "current", meta: "bound" },
    });
  }
  for (const profile of scanGatewayProfiles(cfg.repoPath)) {
    items.push({
      id: `gateway:${profile.id}`,
      label: `[gateway] ${profile.id}${profile.label ? ` — ${profile.label}` : ""}`,
      meta:
        profile.id === cfg.currentGateway
          ? "selected *"
          : `${profile.providers.length} provider${profile.providers.length === 1 ? "" : "s"}`,
      data: { kind: "gateway", id: profile.id, meta: profile.baseUrl },
    });
  }
  // skill/ext 复用 skill-manager / ext-manager 的注册表扫描函数；已声明项打标
  const declared = readAgentManifest(cfg.repoPath, safeAgentName(cfg.currentAgent ?? "coder"));
  for (const skill of scanRegistrySkills(cfg.repoPath)) {
    items.push({
      id: `skill:${skill.name}`,
      label: skill.description ? `[skill] ${skill.name} — ${skill.description}` : `[skill] ${skill.name}`,
      meta: declared.skills.includes(skill.name) ? "declared" : "",
      data: { kind: "skill", id: skill.name, meta: skill.description },
    });
  }
  for (const ext of scanRegistryExtensions(cfg.repoPath)) {
    items.push({
      id: `ext:${ext.name}`,
      label: `[ext] ${ext.name}`,
      meta: declared.extensions.includes(ext.name) ? "declared" : "",
      data: { kind: "ext", id: ext.name, meta: ext.description },
    });
  }
  return items;
}

/**
 * add-gateway 流程（严格按顺序）：
 * 输入 id/label/baseUrl/key → writeCredential → fetchGatewayModels →
 * buildGatewayProfile → writeGatewayProfile → commitPushGateway → notify。
 * commit 前任何一步失败回滚删除 credential，不留半成品。
 * options.fetchImpl 仅测试注入用；key 只传给 fetchGatewayModels 与
 * writeCredential，绝不进 notify / 日志。
 */
export async function addGatewayFlow(
  ctx: ExtensionCommandContext,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.repoUrl || !cfg.repoPath) {
    ctx.ui.notify("No content repo bound; add one first (a → repo)", "warning");
    return;
  }
  const id = ((await ctx.ui.input("Gateway id (lowercase, dashes ok)", "")) ?? "").trim();
  if (!validateRef(id)) {
    ctx.ui.notify(`Invalid gateway id: ${id}`, "error");
    return;
  }
  const label = ((await ctx.ui.input("Label", id)) ?? "").trim() || id;
  const baseUrl = ((await ctx.ui.input("Base URL (…/v1)", "")) ?? "").trim();
  const key = ((await ctx.ui.input("API key", "")) ?? "").trim();
  if (!baseUrl || !key) {
    ctx.ui.notify("baseUrl and API key are required", "error");
    return;
  }

  // key 先落本机 credential store（0600）；失败则中止，不产生半成品
  if (!writeCredential(id, key)) {
    ctx.ui.notify("Failed to store credential (0600 file)", "error");
    return;
  }

  let models: GatewayModel[];
  try {
    models = await fetchGatewayModels(baseUrl, key, { fetchImpl: options.fetchImpl });
  } catch (error) {
    deleteCredential(id);
    ctx.ui.notify(`Model scan failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    return;
  }

  const profile = buildGatewayProfile({
    id,
    label,
    baseUrl,
    credentialRef: id,
    providerId: id,
    api: "openai-completions",
    models,
  });
  if (!profile) {
    deleteCredential(id);
    ctx.ui.notify("Profile failed validation (check baseUrl)", "error");
    return;
  }
  if (!writeGatewayProfile(cfg.repoPath, profile)) {
    deleteCredential(id);
    ctx.ui.notify("Failed to write profile", "error");
    return;
  }
  const result = await commitPushGateway(cfg.repoPath, id, `feat: add gateway ${id}`);
  ctx.ui.notify(
    `Gateway ${id} added (commit=${result.committed}, push=${result.pushed})${result.error ? ` — ${result.error}; run /sync later` : ""}`,
    result.pushed ? "info" : "warning",
  );
}

/** add-repo：GitHub URL + SSH key → bindRepoWithKey（写 ~/.ssh key/config、
 * credential dpi-agent-repo-key、saveConfig、clone+sparse）；失败时通知错误，
 * key/credential 保留供诊断（不再暂存孤儿 repo-<ts> credential）。 */
export async function addRepoFlow(ctx: ExtensionCommandContext): Promise<void> {
  const repoUrl = ((await ctx.ui.input("GitHub repo (https://github.com/user/repo)", "")) ?? "").trim();
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(repoUrl)) {
    ctx.ui.notify("Expected https://github.com/owner/repo", "error");
    return;
  }
  const key = ((await ctx.ui.input("SSH private key", "")) ?? "").trim();
  if (!key) {
    ctx.ui.notify("SSH private key required", "error");
    return;
  }
  const result = await bindRepoWithKey(repoUrl, key);
  if (!result.ok) {
    ctx.ui.notify(
      `Repo bind failed: ${result.error ?? "unknown error"} — SSH key and credential kept for diagnosis`,
      "warning",
    );
    return;
  }
  ctx.ui.notify("Repo bound: SSH key installed, sparse clone ready", "info");
}

/**
 * 按键路由：
 * - add：gateway → addGatewayFlow；repo → addRepoFlow；skill/ext → 各自的
 *   registry manager（复用 runRegistryManager）
 * - delete：gateway → 删 profile + commit；repo → 清 dpi-agent-repo-key 凭证（绑定保留）；
 *   skill/ext → registry manager
 * - status：gateway → checkGatewayHealth 报告；repo/skill/ext → 摘要
 * - pick：gateway/skill/ext 在扩展层处理（useGateway / 名称+描述）；repo → status 提示
 * 返回 "reopen" 表示重开列表（注册表可能已变化），"done" 表示退出控制台。
 */
export async function handleConsoleResult(
  ctx: ExtensionCommandContext,
  result: VimListResult<ConsoleItemData>,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<"reopen" | "done"> {
  if (!result.item) {
    if (result.action === "add") {
      // 空列表 + add：未绑定 repo 时直接走 addRepoFlow（绑定成功后重开列表）；
      // 已绑定则无可添加对象，通知后退出，避免无限重开空列表。
      if (!loadConfig().repoUrl) {
        await addRepoFlow(ctx);
        return "reopen";
      }
      ctx.ui.notify("Nothing to add — bind a repo or add a gateway from the list", "info");
      return "done";
    }
    return "done";
  }
  const item = result.item.data;

  if (result.action === "add") {
    if (item.kind === "gateway") {
      await addGatewayFlow(ctx, options);
      return "reopen";
    }
    if (item.kind === "repo") {
      await addRepoFlow(ctx);
      return "reopen";
    }
    // skill/ext 的 add 走各自的 registry manager（安装流程与 /dpi-skills 一致）
    await runRegistryManager(ctx, item.kind === "skill" ? skillManagerConfig : extManagerConfig);
    return "reopen";
  }

  if (result.action === "delete" && item.kind === "gateway") {
    const cfg = loadConfig();
    if (cfg.repoPath && deleteGatewayProfile(cfg.repoPath, item.id)) {
      await commitPushGateway(cfg.repoPath, item.id, `chore: remove gateway ${item.id}`).catch(() => {});
    }
    return "reopen";
  }

  if (result.action === "delete" && item.kind === "repo") {
    // 删除 addRepoFlow/binder 使用的凭证引用（~/.ssh key/config 与绑定保留，可再登录）
    deleteCredential("dpi-agent-repo-key");
    ctx.ui.notify("Repo binding kept; use /dpi-agent-login to rebind", "info");
    return "reopen";
  }

  if (result.action === "delete") {
    // skill/ext 删除走各自的 registry manager（confirm + 从声明剔除 + reload）
    await runRegistryManager(ctx, item.kind === "skill" ? skillManagerConfig : extManagerConfig);
    return "reopen";
  }

  if (result.action === "status") {
    if (item.kind === "gateway") {
      const cfg = loadConfig();
      const profile = cfg.repoPath
        ? scanGatewayProfiles(cfg.repoPath).find((p) => p.id === item.id)
        : undefined;
      if (!profile) {
        ctx.ui.notify(`Unknown gateway: ${item.id}`, "error");
        return "done";
      }
      const report = await checkGatewayHealth(profile);
      const lines = [
        `Gateway: ${profile.id}`,
        `credential: ${report.credential}`,
        `providers: ${report.providers}`,
        `models: ${report.models}`,
        `/models: ${report.endpoint}${report.latencyMs !== undefined ? ` (${report.latencyMs} ms)` : ""}`,
        ...(report.issues.length ? ["issues:", ...report.issues.map((issue) => `- ${issue}`)] : []),
      ];
      ctx.ui.notify(lines.join("\n"), report.ok ? "info" : "warning");
    } else if (item.kind === "repo") {
      ctx.ui.notify(`repo status: ${item.id}`, "info");
    } else {
      ctx.ui.notify(`status requested: ${item.id}`, "info");
    }
    return "done";
  }

  if (result.action === "pick") {
    if (item.kind === "gateway") {
      ctx.ui.notify(`use gateway: ${item.id} (wire to applyProfile in extension)`, "info");
    } else if (item.kind === "repo") {
      ctx.ui.notify("repo status (wire to inspectRepo)", "info");
    }
    return "done";
  }

  return "done";
}
