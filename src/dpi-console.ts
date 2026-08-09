/**
 * dpi-console：统一 /dpi 控制台（三层导航：top repo 列表 → category
 * Skills/Extensions/Gateways → items 条目列表）＋ 兼容的扁平列表构建。
 *
 * 三层状态机（runConsole）：
 * - top：绑定仓库条目（repo:current，pick 进入 category）+「+ Add repo」
 *   条目（pick / a 走 addRepoFlow 绑定）；s 走 inspectRepo 状态摘要。
 * - category：Skills / Extensions 直接进入 runRegistryManager（其 toggle
 *   列表即第三层）；Gateways 进入 gateway 条目列表（items 层，复用
 *   handleConsoleResult 的 add/delete/status 逻辑；pick 复用 useGateway）。
 * - items：gateway 条目（add/delete/status/pick），Esc 返回 category。
 *
 * 旧的扁平构建（buildConsoleItems / handleConsoleResult）保留不动，供既有
 * 测试与内部复用；条目来源：
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
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, readAgentManifest } from "./config.ts";
import { inspectRepo } from "./repo-doctor.ts";
import { useGateway } from "../extensions/gateway-manager.ts";
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
import { showVimListPicker, type VimListItem, type VimListResult } from "./vim-list-picker.ts";
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

// ============================================================================
// 三层导航（0.8.40）：top（repo 列表）→ category（Skills/Extensions/Gateways）
// → items（条目列表）。旧的扁平构建函数保留，三层导航在其上叠加。
// ============================================================================

export type ConsoleLevel = "top" | "category" | "items";

export type ConsoleNavKind = "repo" | "category" | "gateway" | "skill" | "ext";

export interface ConsoleNavData {
  level: ConsoleLevel;
  kind: ConsoleNavKind;
  id: string;
  meta: string;
}

export type ItemKind = "gateway" | "skill" | "ext";

/** top 层：绑定仓库条目（pick 进入 category）+「+ Add repo」条目（绑定仓库）。 */
export function buildTopItems(cfg: { repoUrl: string; repoPath: string }): VimListItem<ConsoleNavData>[] {
  const items: VimListItem<ConsoleNavData>[] = [];
  if (cfg.repoUrl) {
    items.push({
      id: "repo:current",
      label: `[repo] ${cfg.repoUrl}`,
      meta: "bound",
      data: { level: "top", kind: "repo", id: "current", meta: "bound" },
    });
  }
  items.push({
    id: "repo:add",
    label: "+ Add repo (bind content repo)",
    meta: "",
    data: { level: "top", kind: "repo", id: "add", meta: "" },
  });
  return items;
}

/** category 层：Skills / Extensions / Gateways 三个固定分类。 */
export function buildCategoryItems(): VimListItem<ConsoleNavData>[] {
  return [
    {
      id: "Skills",
      label: "Skills",
      meta: "manage declared skills",
      data: { level: "category", kind: "category", id: "Skills", meta: "manage declared skills" },
    },
    {
      id: "Extensions",
      label: "Extensions",
      meta: "manage declared extensions",
      data: { level: "category", kind: "category", id: "Extensions", meta: "manage declared extensions" },
    },
    {
      id: "Gateways",
      label: "Gateways",
      meta: "list / add / delete gateway profiles",
      data: { level: "category", kind: "category", id: "Gateways", meta: "list / add / delete gateway profiles" },
    },
  ];
}

/** items 层：gateway/skill/ext 条目列表（gateway 复用 scanGatewayProfiles；
 * skill/ext 复用注册表扫描，已声明项打标）。 */
export function buildItemList(
  cfg: { repoPath: string; currentGateway: string; currentAgent?: string },
  kind: ItemKind,
): VimListItem<ConsoleNavData>[] {
  if (kind === "gateway") {
    return scanGatewayProfiles(cfg.repoPath).map((profile) => ({
      id: `gateway:${profile.id}`,
      label: `[gateway] ${profile.id}${profile.label ? ` — ${profile.label}` : ""}`,
      meta:
        profile.id === cfg.currentGateway
          ? "selected *"
          : `${profile.providers.length} provider${profile.providers.length === 1 ? "" : "s"}`,
      data: { level: "items", kind: "gateway", id: profile.id, meta: profile.baseUrl },
    }));
  }
  const declared = readAgentManifest(cfg.repoPath, safeAgentName(cfg.currentAgent ?? "coder"));
  if (kind === "skill") {
    return scanRegistrySkills(cfg.repoPath).map((skill) => ({
      id: `skill:${skill.name}`,
      label: skill.description ? `[skill] ${skill.name} — ${skill.description}` : `[skill] ${skill.name}`,
      meta: declared.skills.includes(skill.name) ? "declared" : "",
      data: { level: "items", kind: "skill", id: skill.name, meta: skill.description },
    }));
  }
  return scanRegistryExtensions(cfg.repoPath).map((ext) => ({
    id: `ext:${ext.name}`,
    label: `[ext] ${ext.name}`,
    meta: declared.extensions.includes(ext.name) ? "declared" : "",
    data: { level: "items", kind: "ext", id: ext.name, meta: ext.description },
  }));
}

/** top 层结果路由：pick 仓库 → "enter"（进 category）；a / pick add 条目 →
 * addRepoFlow → "reopen"（重开 top 列表）；s → inspectRepo 状态摘要 → "reopen"；
 * cancel → "done"（退出控制台）。 */
export async function handleTopResult(
  ctx: ExtensionCommandContext,
  result: VimListResult<ConsoleNavData>,
): Promise<"enter" | "reopen" | "done"> {
  if (!result || result.action === "cancel") return "done";
  if (result.action === "add") {
    await addRepoFlow(ctx);
    return "reopen";
  }
  if (result.action === "status") {
    const report = await inspectRepo({ network: false });
    const lines = [
      `repo: ${report.remoteUrl || "(not bound)"}`,
      `branch: ${report.branch || "—"}`,
      `head: ${report.head || "—"}`,
      report.dirty ? "dirty: yes" : "dirty: clean",
      ...(report.issues.length ? ["issues:", ...report.issues] : []),
    ];
    ctx.ui.notify(lines.join("\n"), report.ok ? "info" : "warning");
    return "reopen";
  }
  if (result.action === "pick" && result.item) {
    const item = result.item.data;
    if (item.kind === "repo" && item.id === "add") {
      await addRepoFlow(ctx);
      return "reopen";
    }
    // 绑定的仓库条目 pick → 进入 category 层
    return "enter";
  }
  return "done";
}

/** category 层结果路由：Skills / Extensions → runRegistryManager（其 toggle 列表
 * 即第三层）→ "back"（回 category）；Gateways → "enter"（进 items 层）；
 * cancel → "back"。 */
export async function handleCategoryResult(
  ctx: ExtensionCommandContext,
  result: VimListResult<ConsoleNavData>,
): Promise<"enter" | "back" | "done"> {
  if (!result || result.action === "cancel") return "back";
  if (result.action === "pick" && result.item) {
    const id = result.item.data.id;
    if (id === "Skills") {
      await runRegistryManager(ctx, skillManagerConfig);
      return "back";
    }
    if (id === "Extensions") {
      await runRegistryManager(ctx, extManagerConfig);
      return "back";
    }
    if (id === "Gateways") return "enter";
  }
  return "back";
}

function toLegacyKind(kind: ConsoleNavKind): ConsoleItemData["kind"] {
  return kind === "category" ? "repo" : kind;
}

/** items 层结果路由：pick gateway → useGateway（pi 注入时真实接线，否则占位提示）
 * → "back"（回 category）；pick skill/ext → 名称+描述 → "back"；
 * add/delete/status 复用 handleConsoleResult（空列表 add 直接走 addGatewayFlow）；
 * cancel → "back"。 */
export async function handleItemResult(
  ctx: ExtensionCommandContext,
  result: VimListResult<ConsoleNavData>,
  options: { pi?: ExtensionAPI; fetchImpl?: typeof fetch } = {},
): Promise<"back" | "reopen"> {
  if (!result || result.action === "cancel") return "back";
  if (result.action === "pick" && result.item) {
    const item = result.item.data;
    if (item.kind === "gateway") {
      if (options.pi) {
        await useGateway(options.pi, item.id, ctx);
      } else {
        ctx.ui.notify(`use gateway: ${item.id} (wire to applyProfile in extension)`, "info");
      }
      return "back";
    }
    if (item.kind === "skill" || item.kind === "ext") {
      ctx.ui.notify(
        item.meta ? `${item.kind}: ${item.id} — ${item.meta}` : `${item.kind}: ${item.id}`,
        "info",
      );
      return "back";
    }
    return "back";
  }
  // 空列表 add：gateway 上下文直接走 addGatewayFlow（不落到 addRepoFlow）
  if (result.action === "add" && !result.item) {
    await addGatewayFlow(ctx, options);
    return "reopen";
  }
  const legacy: VimListResult<ConsoleItemData> = {
    action: result.action,
    item: result.item
      ? {
          id: result.item.id,
          label: result.item.label,
          meta: result.item.meta,
          data: {
            kind: toLegacyKind(result.item.data.kind),
            id: result.item.data.id,
            meta: result.item.data.meta,
          },
        }
      : undefined,
    checked: result.checked,
  };
  const next = await handleConsoleResult(ctx, legacy, options);
  return next === "reopen" ? "reopen" : "back";
}

/** 三层导航主循环：按 level 状态机路由，构建列表 → 处理结果 → 切换层级。
 * options.pi 由扩展层注入（gateway pick 时复用 useGateway 完成真实接线）。 */
export async function runConsole(
  ctx: ExtensionCommandContext,
  options: { pi?: ExtensionAPI; fetchImpl?: typeof fetch } = {},
): Promise<void> {
  if (!ctx.hasUI) {
    const cfg = loadConfig();
    ctx.ui.notify(
      [
        cfg.repoUrl ? `repo: ${cfg.repoUrl}` : "repo: none — use /dpi a to bind",
        "categories: Skills · Extensions · Gateways",
      ].join("\n"),
      "info",
    );
    return;
  }

  let level: ConsoleLevel = "top";
  let currentKind: ItemKind = "gateway";
  for (;;) {
    const cfg = loadConfig();
    const items =
      level === "top"
        ? buildTopItems(cfg)
        : level === "category"
          ? buildCategoryItems()
          : buildItemList(cfg, currentKind);
    const title =
      level === "top" ? "dpi console" : level === "category" ? "dpi — category" : `dpi — ${currentKind}`;
    const actions =
      level === "top"
        ? [
            { key: "a", id: "add", hint: "add" },
            { key: "s", id: "status", hint: "status" },
          ]
        : level === "items"
          ? [
              { key: "a", id: "add", hint: "add" },
              { key: "d", id: "delete", hint: "delete" },
              { key: "s", id: "status", hint: "status" },
            ]
          : undefined;
    const result = await showVimListPicker<ConsoleNavData>(ctx, {
      title,
      items,
      mode: "select",
      actions,
      hint: "j/k nav · / filter · Enter select · Esc back/quit",
    });
    if (!result) return; // TUI 不可用/异常

    if (level === "top") {
      const next = await handleTopResult(ctx, result);
      if (next === "done") return;
      if (next === "enter") level = "category";
      continue; // "reopen" 留在 top 层
    }
    if (level === "category") {
      const next = await handleCategoryResult(ctx, result);
      if (next === "done") return;
      if (next === "enter") {
        level = "items";
        currentKind = "gateway";
      }
      continue; // "back" 留在 category 层
    }
    const next = await handleItemResult(ctx, result, options);
    if (next === "back") level = "category";
    // "reopen" 留在 items 层（列表已变化）
  }
}
